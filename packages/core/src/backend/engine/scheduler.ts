/**
 * What runs a node, and what runs next once it has.
 *
 * One `NodeScheduler` is built per run and holds that run's ports and identity,
 * which is what every node is executed against. Node work is a strategy table
 * (`strategies/`); this class owns deferral, drain and cancel routing. What each node left behind is `Traversal`'s, and where a
 * cancellation routes the run is `CancelBoundary`'s.
 */

import {
  collectEntityStateConditionReferences,
  parseConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { ENTITY_STATE_SOURCE_ID } from "@wfgraph/shared/graph/node-references";
import { extractConsumedTemplateReferences } from "@wfgraph/shared/plugins/template-config";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import type { ExecutionSide } from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  waitMatchTemplateStringsIn,
  waitTemplateKeysIn,
} from "@wfgraph/shared/lifecycle/wait-subscription";
import {
  actionTypeOf,
  isConditionNode,
  isWaitNode,
  readConfigString,
} from "@wfgraph/shared/graph/node-config";
import {
  type JsonObject,
  readJsonObjectLeniently,
  readJsonValue,
} from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { Cause, Effect, Option, Schema } from "effect";
import { uniq } from "es-toolkit/array";
import type { WorkflowActions } from "#src/backend/engine/actions";
import type {
  EntityTemplateContext,
  WorkflowEntities,
} from "#src/backend/engine/entities";
import type { CancelBoundary } from "#src/backend/engine/cancel-boundary";
import {
  executionData,
  executionError,
  failedExecution,
} from "#src/backend/engine/contracts";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import type { PendingCancel, WorkflowStore } from "#src/backend/engine/store";
import type { Traversal } from "#src/backend/engine/traversal";
import {
  resolveStrategy,
  routeAfterStrategy,
  type NodeWorkContext,
  type NodeWorkOutcome,
} from "#src/backend/engine/strategies/index";
import {
  type EngineFailure,
  failureFromCause,
} from "#src/backend/engine/engine-failure";
import { runDurable } from "#src/backend/engine/durable";

/** What the run log and the trace call a node. */
function getNodeName(node: WorkflowNode, actions: WorkflowActions): string {
  if (node.data.label) {
    return node.data.label;
  }
  if (node.data.type === "action") {
    const actionType = readConfigString(node.data.config, "actionType");
    if (actionType) {
      // The label comes from the assembled catalog, so a run log names an action
      // the way the editor does.
      const label = actions.metadataFor(actionType)?.label;
      if (label) {
        return label;
      }
    }
    return "Action";
  }
  if (node.data.type === "lifecycle") {
    return "Lifecycle";
  }
  return node.data.type;
}

/**
 * Raised when a walk of the body settles with a Wait parked: every branch has
 * run as far as it can, and at least one is halted on a park the runtime has
 * not resolved. `executeWorkflow` catches it in one place and ends the pass
 * parked, with no terminal record.
 */
export class PassParked extends Schema.TaggedError<
  PassParked,
  { readonly brand: unique symbol }
>()("PassParked", {}) {}

/** Whether a cause is a walk that settled with a Wait parked. */
export function isPassParked(cause: Cause.Cause<unknown>): boolean {
  return Option.exists(
    Cause.findErrorOption(cause),
    (error) => error instanceof PassParked
  );
}

/** The ports and the run identity every node of one run is executed against. */
export type NodeSchedulerInput = {
  traversal: Traversal;
  cancelBoundary: CancelBoundary;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  actions: WorkflowActions;
  entities: WorkflowEntities;
  executionId: string;
  workflowId: string;
  /** The Workflow Version whose graph this run is walking. */
  workflowVersionId: string;
  workflowRunId: string;
  runMode: "live" | "test";
  /** What the entry node hands on: see `WorkflowExecutionInput.startPayload`. */
  startPayload: JsonObject;
  /** The Event that started the run: see `WorkflowExecutionInput.startEventName`. */
  startEventName: string | null;
  /**
   * Catalog fingerprint the published version pinned. Compared against the live
   * catalog when an action resolves.
   */
  catalogFingerprint: string;
  /** Immutable tracked Entity identity available to node-local State reads. */
  trackedEntity?:
    | {
        entityType: string;
        entityId: string;
      }
    | undefined;
  /** Immutable identity and authored rule for per-node Entity Eligibility. */
  entityEligibility?:
    | {
        entityType: string;
        entityId: string;
        condition: string;
        conditionId: string;
      }
    | undefined;
};

type NodeAdmission =
  | { admitted: false }
  | {
      admitted: true;
      entityContext?: EntityTemplateContext | undefined;
    };

/** Entity State paths this node will actually consume at run time. */
function entityReferencePaths(
  node: WorkflowNode,
  actions: WorkflowActions,
  sourceId: string,
  entityType: string
): string[] {
  if (node.data.type !== "action") {
    return [];
  }
  const config = readJsonObjectLeniently(node.data.config);
  if (!config) {
    return [];
  }

  const actionType = actionTypeOf(node);
  const metadata = actionType ? actions.metadataFor(actionType) : undefined;
  const activeWaitKeys = isWaitNode(node)
    ? new Set<string>(waitTemplateKeysIn(config))
    : undefined;
  const literalKeys = new Set(metadata?.literalConfigKeys ?? []);

  const templatePaths = extractConsumedTemplateReferences(
    config,
    {
      literalKeys,
      jsonShapes: new Map(metadata?.templateJsonConfigShapes ?? []),
      activeKeys: activeWaitKeys,
    },
    isWaitNode(node) ? waitMatchTemplateStringsIn(config) : []
  )
    .filter(
      (reference) =>
        reference.nodeId === sourceId &&
        reference.sourceType === entityType &&
        reference.fieldPath.length > 0
    )
    .map((reference) => reference.fieldPath);

  const parsedCondition = isConditionNode(node)
    ? parseConditionModel(config.conditionModel)
    : undefined;
  const conditionPaths =
    parsedCondition?.valid === true
      ? collectEntityStateConditionReferences(parsedCondition.model)
          .filter((reference) => reference.entityType === entityType)
          .map((reference) => reference.fieldPath)
      : [];

  return uniq([...templatePaths, ...conditionPaths]);
}

export class NodeScheduler {
  private readonly input: NodeSchedulerInput;

  /**
   * Wait nodes whose dependencies are met, held back until every other branch
   * has run as far as it can. A Wait entered after the fan-out settles parks
   * only its own branch, and every branch that parks nothing has already run
   * by then.
   */
  private readonly deferredWaits = new Set<string>();

  /** Wait nodes the drain has dealt with, which are no longer held back. */
  private readonly drainedWaits = new Set<string>();

  /**
   * The Event the nodes running now arrived on, before a Cancel Event takes the
   * Canceled outlet. Starts as the Start Event, becomes the Event that woke the
   * most recent event-mode Wait, and is cleared when that Wait times out and
   * continues.
   */
  private arrivingEventName: string | null;

  constructor(input: NodeSchedulerInput) {
    this.input = input;
    this.arrivingEventName = input.startEventName;
  }

  /**
   * Which side of the Lifecycle Node a node sits on, read off the graph rather
   * than off how far this run got, so it answers the same on a replay.
   */
  private sideOf(nodeId: string): ExecutionSide {
    return this.input.cancelBoundary.isOnCanceledBranch(nodeId)
      ? "canceled"
      : "started";
  }

  /**
   * The Event the nodes running now arrived on: the Cancel Event once the run
   * has taken the Canceled outlet, the Event that woke the most recent
   * event-mode Wait below that, and the Start Event before either. A timeout
   * that continues past an event-mode Wait, or a run nothing named an Event
   * for, answers null, which a rule compares false against.
   */
  private currentEventName(): string | null {
    return (
      this.input.cancelBoundary.canceledByEvent() ?? this.arrivingEventName
    );
  }

  /**
   * Resolves one durable Entity snapshot for this node, then linearizes its
   * admission against execution-wide Cancel and Exit claims.
   *
   * Started-side Eligibility and template references share the snapshot. A
   * Canceled-side node can read referenced fields but does not run Eligibility.
   * Durable ids follow node identity across Migration, so replay reuses values
   * already observed while the first newly reached node reads current State.
   */
  private admitExecutableNode(
    node: WorkflowNode,
    nodeName: string
  ): Effect.Effect<NodeAdmission, EngineFailure> {
    if (node.data.enabled === false || node.data.type !== "action") {
      return Effect.succeed({ admitted: true });
    }

    const onCanceledSide = this.input.cancelBoundary.isOnCanceledBranch(
      node.id
    );
    const eligibility = onCanceledSide
      ? undefined
      : this.input.entityEligibility;
    const entity = this.input.trackedEntity ?? eligibility;
    if (!entity) {
      return Effect.succeed({ admitted: true });
    }
    const sourceId = ENTITY_STATE_SOURCE_ID;
    const paths = entityReferencePaths(
      node,
      this.input.actions,
      sourceId,
      entity.entityType
    );
    if (!eligibility && paths.length === 0) {
      return Effect.succeed({ admitted: true });
    }

    const { runtime, store, entities, executionId } = this.input;

    return Effect.gen(
      function* (this: NodeScheduler) {
        // Started-side host reads sit between two claim checks, so a Cancel that
        // wins while the Entity resolver is in flight stops the action itself.
        if (!onCanceledSide) {
          const boundaryOpen = yield* runDurable(
            runtime,
            {
              id: `node-boundary:${node.id}`,
              name: `${nodeName} (boundary)`,
            },
            store.admitNode(executionId)
          );
          if (!boundaryOpen) {
            return { admitted: false } as const;
          }
        }

        const resolution = yield* runDurable(
          runtime,
          {
            id:
              paths.length > 0
                ? `entity-context:${node.id}`
                : `entity-eligibility:${node.id}`,
            name: `${nodeName} (Entity)`,
          },
          entities.resolveNode(
            omitUndefined({
              entityType: entity.entityType,
              entityId: entity.entityId,
              nodeId: node.id,
              condition: eligibility?.condition,
              eventName: this.currentEventName(),
              paths,
            })
          )
        );

        if (resolution.decision.outcome === "exit") {
          const decision = resolution.decision;
          yield* runDurable(
            runtime,
            {
              id: `entity-exit:${node.id}`,
              name: `${nodeName} (Exit)`,
            },
            store.requestExit({
              executionId,
              reason: decision.reason,
              nodeId: node.id,
              checkedAt: decision.checkedAt,
            })
          );

          // The claim that wins resolves every other park of the run with an
          // `exit` wake in the same write, so a parked sibling branch halts on
          // the next pass.
          return { admitted: false } as const;
        }

        if (onCanceledSide) {
          return {
            admitted: true,
            entityContext: {
              sourceId,
              entityType: entity.entityType,
              values: resolution.values,
            },
          } as const;
        }

        const admitted = yield* runDurable(
          runtime,
          {
            id: `node-admission:${node.id}`,
            name: `${nodeName} (admit)`,
          },
          store.admitNode(executionId)
        );
        return admitted
          ? ({
              admitted: true,
              entityContext: {
                sourceId,
                entityType: entity.entityType,
                values: resolution.values,
              },
            } as const)
          : ({ admitted: false } as const);
      }.bind(this)
    );
  }

  /**
   * Applies a Wait's Arriving Event change: a named Event replaces the one the
   * run was on, and `null` clears it so an Event Split below a timed-out Wait
   * does not take a Start Event outlet.
   *
   * The entry node's output becomes that payload, matching a Cancel Event. A
   * clear writes an empty payload, so Start Event fields are not what a node
   * below the Wait addresses.
   */
  private applyArrival(
    arrivingEvent: { eventName: string; payload: JsonObject } | null
  ) {
    this.arrivingEventName = arrivingEvent?.eventName ?? null;
    const payload = arrivingEvent?.payload ?? {};
    const { traversal } = this.input;
    for (const lifecycleNode of traversal.lifecycleNodes) {
      traversal.setOutput(lifecycleNode.id, {
        label: lifecycleNode.data.label || lifecycleNode.id,
        data: payload,
      });
    }
  }

  // The persisted graph is validated as a DAG before execution, so we avoid
  // per-call cycle-tracking allocations on this hot path.
  private executeNode(nodeId: string): Effect.Effect<void, EngineFailure> {
    const execute = Effect.gen(
      function* (this: NodeScheduler) {
        const { traversal, actions } = this.input;

        if (traversal.isCompleted(nodeId)) {
          return;
        }

        // AND-join: a node with several predecessors waits until each has
        // released it. The predecessor that finishes first schedules us early
        // and we no-op; the last one finds us ready.
        if (!traversal.isReadyToRun(nodeId)) {
          return;
        }

        const node = traversal.getNode(nodeId);
        if (!node) {
          yield* Effect.logWarning("Node not found");
          return;
        }

        // A disabled Wait parks nothing, so the scheduler has no reason to hold it
        // back and it runs where it stands.
        if (
          node.data.enabled !== false &&
          isWaitNode(node) &&
          !this.drainedWaits.has(nodeId)
        ) {
          this.deferredWaits.add(nodeId);
          yield* Effect.logDebug(
            "Holding wait node until every other branch has drained"
          );
          return;
        }

        const nodeName = getNodeName(node, actions);
        const actionType = actionTypeOf(node);

        // Admission can suspend. Own the node before those reads so another
        // predecessor cannot admit and execute the same join concurrently.
        yield* traversal.withNodeInProgress(nodeId, () =>
          Effect.gen(
            function* (this: NodeScheduler) {
              const admission = yield* this.admitExecutableNode(node, nodeName);
              if (!admission.admitted) {
                const cancel = yield* this.input.cancelBoundary.settle(nodeId);
                if (cancel.entered) {
                  yield* this.runAll(cancel.nextNodes);
                }
                return;
              }

              const nodeExecution = this.executeNodeInner(
                nodeId,
                node,
                nodeName,
                admission.entityContext
              ).pipe(
                Effect.withSpan("wfgraph.workflow.node.execute", {
                  // A span attribute set to `undefined` is recorded as the string
                  // `"undefined"`, so an unconfigured node's missing action type has
                  // to be an absent key.
                  attributes: omitUndefined({
                    "wfgraph.node.id": nodeId,
                    "wfgraph.node.name": nodeName,
                    "wfgraph.node.type": node.data.type,
                    "wfgraph.action.type": actionType,
                  }),
                })
              );
              yield* nodeExecution;
            }.bind(this)
          )
        );
      }.bind(this)
    );

    return Effect.catchCauseIf(
      execute,
      // A pass that lost its lease ends where it stands, and no node failed.
      (cause) => failureFromCause(cause).kind !== "lease_lost",
      (cause) =>
        Effect.gen(
          function* (this: NodeScheduler) {
            // This is the attribution boundary: a cause becomes the node's failure
            // value here, while sibling nodes continue.
            yield* Effect.logError("Unexpected error executing node").pipe(
              Effect.annotateLogs({ error: Cause.squash(cause) })
            );
            this.input.traversal.markCompleted(
              nodeId,
              failedExecution(failureFromCause(cause))
            );
            const cancel = yield* this.input.cancelBoundary.settle(nodeId);
            if (cancel.entered) {
              yield* this.runAll(cancel.nextNodes);
            }
          }.bind(this)
        ).pipe(
          Effect.catchCause((recoveryCause) =>
            Effect.logError(
              "Failed to settle cancellation after node failure"
            ).pipe(Effect.annotateLogs({ error: Cause.squash(recoveryCause) }))
          )
        )
    ).pipe(Effect.annotateLogs({ node: { id: nodeId } }));
  }

  /**
   * The node's own work: resolve a strategy and run it.
   *
   * It schedules no downstream node. A handler's own `step.run` calls are
   * durable steps, and a step never runs inside another, so what the traversal
   * needs afterwards travels back in the returned outcome.
   */
  private runNodeWork(
    node: WorkflowNode,
    nodeName: string,
    entityContext?: EntityTemplateContext
  ): Effect.Effect<NodeWorkOutcome, EngineFailure> {
    return Effect.gen(
      function* (this: NodeScheduler) {
        const {
          traversal,
          runtime,
          store,
          actions,
          executionId,
          workflowId,
          workflowRunId,
          runMode,
          startPayload,
        } = this.input;

        // A disabled node is skipped and its branch ends at it, so nothing below
        // is ever scheduled. Carrying on would mean guessing: a Condition has no
        // boolean to route on, and a step below a skipped lookup would read the
        // null it left behind as an answer. The editor draws the whole subtree
        // muted for the same reason.
        if (node.data.enabled === false) {
          yield* Effect.logInfo("Skipping disabled node");
          return {
            status: "settled" as const,
            result: { success: true as const, data: null },
            haltBranch: true,
          };
        }

        const strategy = resolveStrategy(node);
        const ctx: NodeWorkContext = {
          node,
          nodeName,
          traversal,
          runtime,
          store,
          actions,
          executionId,
          workflowId,
          workflowRunId,
          runMode,
          startPayload,
          entityContext,
          eventName: this.currentEventName(),
          catalogFingerprint: this.input.catalogFingerprint,
          workflowVersionId: this.input.workflowVersionId,
          side: this.sideOf(node.id),
        };

        return yield* strategy.run(ctx);
      }.bind(this)
    );
  }

  /**
   * Records a node's outcome and schedules its downstream branches.
   */
  private executeNodeInner(
    nodeId: string,
    node: WorkflowNode,
    nodeName: string,
    entityContext?: EntityTemplateContext
  ): Effect.Effect<void, EngineFailure> {
    const actionType = actionTypeOf(node);
    const kind = actionType ?? node.data.type;

    /**
     * The one record this node writes, whatever it did.
     *
     * Everything a reader wants about a node execution is here: what ran, how
     * it ended, how long it took, and whichever of halting, cancelling or a
     * condition applied. The engine used to say the same in four to six
     * records, which is what buried the run.
     */
    const logNode = (
      startedAt: number,
      status: string,
      extra: Record<string, unknown>
    ) => {
      const elapsedMs = Date.now() - startedAt;
      return Effect.logInfo(
        `${nodeName} (${kind}) ${status} ${elapsedMs}ms`
      ).pipe(
        Effect.annotateLogs({
          // The pretty formatter prints a `key=value` pair for every key of the
          // group, so a key holding `undefined` reaches the reader as
          // `error=undefined`. An unconfigured node's missing action type and a
          // successful node's missing failure are absent keys instead.
          node: omitUndefined({
            id: nodeId,
            name: nodeName,
            type: node.data.type,
            action: actionType,
            status,
            ms: elapsedMs,
            ...extra,
          }),
        })
      );
    };

    const execute = Effect.gen(
      function* (this: NodeScheduler) {
        const { traversal, cancelBoundary } = this.input;
        const startedAt = Date.now();
        const outcome = yield* this.runNodeWork(node, nodeName, entityContext);

        // The node stays unfinished (no result, no release, no boundary read);
        // the next pass of the body enters the Wait again.
        if (outcome.status === "parked") {
          traversal.markParked(nodeId);
          yield* logNode(startedAt, "parked", {});
          return;
        }

        const { result } = outcome;

        if (outcome.executionExited) {
          return;
        }

        // A node with no action type never produced an output, so it is recorded
        // as failed without becoming available to downstream templates.
        if (outcome.unconfigured) {
          traversal.recordResult(nodeId, result);
          yield* logNode(startedAt, "unconfigured", {});
          return;
        }

        // A step result crosses the step memo as JSON, so this is where it
        // becomes JSON again for the template resolver and the CEL
        // context to walk.
        const payload = executionData(result);
        const outputData = readJsonValue(payload);
        if (outputData === null && payload !== null) {
          yield* Effect.logWarning(
            "Node output is not JSON and will read as empty downstream"
          ).pipe(
            Effect.annotateLogs({
              actionType: node.data.config?.actionType,
            })
          );
        }
        traversal.markCompleted(nodeId, result, {
          label: node.data.label || nodeId,
          data: outputData,
        });

        if (outcome.arrivingEvent !== undefined) {
          this.applyArrival(outcome.arrivingEvent);
        }

        const failure = executionError(result);
        yield* logNode(startedAt, result.success ? "success" : "failed", {
          // oxlint-disable-next-line wfgraph/no-conditional-spread -- `haltBranch` is a boolean, so `omitUndefined` would keep `halt: false` on every ordinary node.
          ...(outcome.haltBranch === true ? { halt: true } : {}),
          // oxlint-disable-next-line wfgraph/no-conditional-spread -- only a Condition node has a branch to report.
          ...(isConditionNode(node)
            ? { condition: outcome.conditionValue ?? null }
            : {}),
          error: failure,
        });

        // A claimed run takes the Canceled outlet instead of whatever came next,
        // and a node that finishes after that stops where it stands.
        const cancel = yield* cancelBoundary.settle(nodeId);
        if (cancel.entered) {
          yield* this.runAll(cancel.nextNodes);
          return;
        }

        if (!result.success || outcome.haltBranch) {
          return;
        }

        const route = routeAfterStrategy(
          node,
          this.currentEventName(),
          outcome
        );

        // A Condition whose expression produced no boolean routes nowhere. The
        // value it did produce is on the node's own record above.
        if (!route) {
          return;
        }

        const nextNodes = traversal.markReadyForDownstream(nodeId, route);
        yield* this.runAll(nextNodes);
      }.bind(this)
    );

    return execute;
  }

  /**
   * Runs the Canceled outlet for a Cancel claim read after the Started branch
   * ran out, in the order a boundary read runs it mid-traversal: enter the
   * outlet, run its first nodes, then enter the Waits held back on its side.
   *
   * The Started-side Waits were drained before the claim was read, so the drain
   * here finds only Waits behind the outlet, and one of them may park the run
   * the way any Wait does, which fails the outlet with `PassParked`.
   */
  runCanceledOutlet(
    claim: PendingCancel
  ): Effect.Effect<void, EngineFailure | PassParked> {
    return Effect.gen(
      function* (this: NodeScheduler) {
        const nextNodes = yield* this.input.cancelBoundary.enterClaimed(claim);
        yield* this.runAll(nextNodes);
        yield* this.settle();
      }.bind(this)
    );
  }

  /**
   * Ends a walk of the body: enters the Waits held back, then fails with
   * `PassParked` when any Wait of this pass is left parked. Every walk of a run
   * ends here, so this is the one place a pass is found to have parked.
   */
  settle(): Effect.Effect<void, EngineFailure | PassParked> {
    return this.drainDeferredWaits().pipe(
      Effect.andThen(
        Effect.suspend(() =>
          this.input.traversal.openParkCount > 0
            ? Effect.fail(new PassParked())
            : Effect.void
        )
      )
    );
  }

  /** Runs a set of nodes side by side, which is how every branch fans out. */
  runAll(nodeIds: readonly string[]): Effect.Effect<void[], EngineFailure> {
    return Effect.forEach(nodeIds, (nodeId) => this.executeNode(nodeId), {
      concurrency: "unbounded",
    });
  }

  /**
   * Enters the Wait nodes `executeNode` held back, and keeps going until none
   * are left. Call it once the fan-out has settled, so anything still runnable
   * has run by now.
   *
   * The batch is entered side by side. A Wait the runtime answers as parked
   * halts its own branch alone, and the rest of the batch carries on. Each
   * round may reach further waits, and the loop terminates because a wait the
   * drain has dealt with never returns to the queue.
   *
   * A run that has taken the Canceled outlet drops whatever it was holding for
   * the Started branch. Every other node stops there by never being scheduled,
   * and a wait held back since before the crossing would otherwise park the run
   * on a branch it has left.
   */
  private drainDeferredWaits(): Effect.Effect<void, EngineFailure> {
    return Effect.gen(
      function* (this: NodeScheduler) {
        const { cancelBoundary } = this.input;

        while (this.deferredWaits.size > 0) {
          const batch = [...this.deferredWaits].filter(
            (nodeId) =>
              !cancelBoundary.hasLeftStartedBranch() ||
              cancelBoundary.isOnCanceledBranch(nodeId)
          );
          this.deferredWaits.clear();
          for (const nodeId of batch) {
            this.drainedWaits.add(nodeId);
          }
          yield* this.runAll(batch);
        }
      }.bind(this)
    );
  }
}
