/**
 * What runs a node, and what runs next once it has.
 *
 * One `NodeScheduler` is built per run and holds that run's ports and identity,
 * which is what every node is executed against. Node work is a strategy table
 * (`strategies/`); this class owns deferral, drain, branch hand-off, and
 * cancel routing. What each node left behind is `Traversal`'s, and where a
 * cancellation routes the run is `CancelBoundary`'s.
 */

import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  actionTypeOf,
  isConditionNode,
  isWaitNode,
  readConfigString,
} from "@wfgraph/shared/graph/node-config";
import { type JsonObject, readJsonValue } from "@wfgraph/shared/types/json";
import { Cause, Effect } from "effect";
import type { WorkflowActions } from "#src/backend/engine/actions";
import type { CancelBoundary } from "#src/backend/engine/cancel-boundary";
import {
  executionData,
  executionError,
  failedExecution,
} from "#src/backend/engine/contracts";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import type { WorkflowStore } from "#src/backend/engine/store";
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
import {
  fromUnknownPromise,
  runDurableUnit,
} from "#src/backend/engine/durable";

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

/** The ports and the run identity every node of one run is executed against. */
export type NodeSchedulerInput = {
  traversal: Traversal;
  cancelBoundary: CancelBoundary;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  actions: WorkflowActions;
  executionId: string;
  workflowId: string;
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
  /**
   * The Wait node this run was handed, on a run that is itself a branch. It is
   * the one Wait this run enters in place rather than hands on again, which is
   * what stops a branch from handing itself off forever.
   */
  branchEntryNodeId?: string | undefined;
};

export class NodeScheduler {
  private readonly input: NodeSchedulerInput;

  /**
   * Wait nodes whose dependencies are met, held back until every other branch
   * has run as far as it can. A durable runtime suspends the run rather than the
   * branch: Inngest parks the whole function invocation on a sleep and drives no
   * other branch forward until the timer fires, so a Wait entered early makes
   * every sibling wait with it.
   */
  private readonly deferredWaits = new Set<string>();

  /**
   * Wait nodes the drain has dealt with, which are no longer held back. How
   * each is then entered is `entersInPlace` below.
   */
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
    if (input.branchEntryNodeId) {
      this.drainedWaits.add(input.branchEntryNodeId);
    }
  }

  /**
   * Whether this Wait is entered here rather than handed to a run of its own.
   *
   * Two nodes are. The Wait a branch run was handed, which is the whole of what
   * that run exists to enter, and every Wait at all when the runtime starts no
   * durable runs.
   */
  private entersInPlace(nodeId: string): boolean {
    return (
      !this.input.runtime.startBranch || nodeId === this.input.branchEntryNodeId
    );
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
   * Applies a Wait's Arriving Event change: a named Event replaces the one the
   * run was on, and `null` clears it so an Event Split below a timed-out Wait
   * does not take a Start Event outlet.
   *
   * The entry node's output becomes that payload, matching a Cancel Event. A
   * clear writes an empty payload, so Start Event fields are not what a node
   * below the Wait addresses. `setOwnOutput` is what lets a branch run hand
   * the overwrite back to the run that started it.
   */
  private applyArrival(
    arrivingEvent: { eventName: string; payload: JsonObject } | null
  ) {
    this.arrivingEventName = arrivingEvent?.eventName ?? null;
    const payload = arrivingEvent?.payload ?? {};
    const { traversal } = this.input;
    for (const lifecycleNode of traversal.lifecycleNodes) {
      traversal.setOwnOutput(lifecycleNode.id, {
        label: lifecycleNode.data.label || lifecycleNode.id,
        data: payload,
      });
    }
  }

  // The persisted graph is validated as a DAG before execution, so we avoid
  // per-call cycle-tracking allocations on this hot path.
  private executeNode(nodeId: string): Effect.Effect<void> {
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

        const nodeExecution = this.executeNodeInner(
          nodeId,
          node,
          nodeName
        ).pipe(
          Effect.withSpan("wfgraph.workflow.node.execute", {
            attributes: {
              "wfgraph.node.id": nodeId,
              "wfgraph.node.name": nodeName,
              "wfgraph.node.type": node.data.type,
              ...(actionType === undefined
                ? {}
                : { "wfgraph.action.type": actionType }),
            },
          })
        );
        yield* traversal.withNodeInProgress(nodeId, () => nodeExecution);
      }.bind(this)
    );

    return Effect.catchCause(execute, (cause) =>
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
   * It schedules no downstream node. A handler's own `step.run` calls are steps,
   * and Inngest forbids nesting one step inside another, so what the traversal
   * needs afterwards travels back in the returned outcome.
   */
  private runNodeWork(
    node: WorkflowNode,
    nodeName: string
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
          eventName: this.currentEventName(),
          catalogFingerprint: this.input.catalogFingerprint,
          entersInPlace: this.entersInPlace(node.id),
          handOffBranch: () => this.handOffBranch(node, nodeName),
        };

        return yield* strategy.run(ctx);
      }.bind(this)
    );
  }

  /**
   * Hands one Wait node and everything behind it to a durable run of its own,
   * and takes on what that run did.
   *
   * The branch was walked by the run that comes back, so nothing below this node
   * is scheduled here and `haltBranch` is how the traversal is told. The node's
   * own outcome is the one that run recorded for it, which is what keeps a Wait
   * that failed reading as a failure on either side of the hand-off.
   *
   * Only `entersInPlace` reaches this, and it answers false for a runtime with
   * no `startBranch`, which is why the port method is read without a check.
   */
  private handOffBranch(
    node: WorkflowNode,
    nodeName: string
  ): Effect.Effect<NodeWorkOutcome, EngineFailure> {
    return Effect.gen(
      function* (this: NodeScheduler) {
        const { traversal, runtime } = this.input;

        yield* Effect.logInfo(
          "Handing the branch below this wait to its own run"
        );
        const startBranch = runtime.startBranch;
        if (!startBranch) {
          return yield* Effect.die(
            new Error(
              `Node "${node.id}" was handed off to a branch run by a runtime that starts none.`
            )
          );
        }
        const handoff = yield* fromUnknownPromise(() =>
          startBranch(
            { id: `branch-${node.id}`, name: `${nodeName} (branch)` },
            {
              entryNodeId: node.id,
              releasedNodeIds: traversal.releasedNodeIds,
            }
          )
        );

        if (handoff.status === "killed") {
          // The cancellation killed the branch where it stood. Its rows are closed
          // here, and the boundary read below this node is what routes the run.
          yield* this.sweepKilledBranchWork();
          yield* Effect.logInfo("Branch run was cancelled");
          return {
            result: {
              success: true as const,
              data: { branchCancelled: true },
            },
            haltBranch: true,
          };
        }

        traversal.absorbBranch(handoff.result);

        const own = handoff.result.results[node.id] ?? {
          success: true as const,
          data: null,
        };
        // The branch run walked everything below this node, so this run schedules
        // none of it. A Wait that failed keeps reading as a failure on both sides.
        return { result: own, haltBranch: own.success };
      }.bind(this)
    );
  }

  /**
   * Closes every row of this run still open, which is what a killed branch
   * leaves behind: its node rows and its wait states.
   *
   * The ordering is the whole of what makes this safe, so it is stated here.
   * It runs after the kill has been observed, when no branch run is alive to
   * write to those rows, and before the Canceled outlet is entered, because a
   * Canceled branch opening with a one-week Wait would otherwise leave a killed
   * node reading Running for a week. One event kills every branch of a run at
   * once, which is why closing all of them at the first observed kill closes
   * nothing that is still going.
   *
   * Two killed branches resolving in one pass both reach this, because neither
   * has been memoized yet. The write is idempotent, and the step id keeps a
   * later replay from repeating it.
   */
  private sweepKilledBranchWork(): Effect.Effect<void, EngineFailure> {
    const { runtime, store, executionId } = this.input;
    return Effect.asVoid(
      runDurableUnit(
        runtime,
        { id: "branch-kill-sweep", name: "Branch kill sweep" },
        store.cancelOpenWork({ executionId })
      )
    );
  }

  /**
   * Records a node's outcome and schedules its downstream branches.
   */
  private executeNodeInner(
    nodeId: string,
    node: WorkflowNode,
    nodeName: string
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
          node: {
            id: nodeId,
            name: nodeName,
            type: node.data.type,
            ...(actionType === undefined ? {} : { action: actionType }),
            status,
            ms: elapsedMs,
            ...extra,
          },
        })
      );
    };

    const execute = Effect.gen(
      function* (this: NodeScheduler) {
        const { traversal, cancelBoundary } = this.input;
        const startedAt = Date.now();
        const outcome = yield* this.runNodeWork(node, nodeName);
        const { result } = outcome;

        // A node with no action type never produced an output, so it is recorded
        // as failed without becoming available to downstream templates.
        if (outcome.unconfigured) {
          traversal.recordResult(nodeId, result);
          yield* logNode(startedAt, "unconfigured", {});
          return;
        }

        // A step result crosses Inngest's memoization boundary as JSON, so this is
        // where it becomes JSON again for the template resolver and the CEL
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
          ...(outcome.haltBranch === true ? { halt: true } : {}),
          ...(isConditionNode(node)
            ? { condition: outcome.conditionValue ?? null }
            : {}),
          ...(failure === undefined ? {} : { error: failure }),
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

        const nextNodes = traversal.nextNodes(nodeId, route);
        traversal.markReadyForDownstream(nodeId);
        yield* this.runAll(nextNodes);
      }.bind(this)
    );

    return execute;
  }

  /** Runs a set of nodes side by side, which is how every branch fans out. */
  runAll(nodeIds: readonly string[]): Effect.Effect<void[]> {
    return Effect.all(
      nodeIds.map((nodeId) => this.executeNode(nodeId)),
      { concurrency: "unbounded" }
    );
  }

  /**
   * Enters the Wait nodes `executeNode` held back, and keeps going until none
   * are left. Call it once the fan-out has settled: the run is about to suspend,
   * so anything still runnable has to have run by now.
   *
   * This is where a branch is handed off. A runtime that starts durable runs
   * gets one per waiting branch, which is how a short wait stops costing what a
   * long sibling costs; a runtime that starts none enters the wait in place, and
   * the batch is entered side by side so two sibling timers still overlap. Each
   * round may reach further waits, and the loop terminates because a wait the
   * drain has dealt with never returns to the queue.
   *
   * A run that has taken the Canceled outlet drops whatever it was holding for
   * the Started branch. Every other node stops there by never being scheduled,
   * and a wait held back since before the crossing would otherwise park the run
   * on a branch it has left.
   */
  drainDeferredWaits(): Effect.Effect<void> {
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
