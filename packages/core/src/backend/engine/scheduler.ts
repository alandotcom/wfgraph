/**
 * What runs a node, and what runs next once it has.
 *
 * One `NodeScheduler` is built per run and holds that run's ports and identity,
 * which is what every node is executed against. What each node left behind is
 * `Traversal`'s, and where a cancellation routes the run is `CancelBoundary`'s.
 */

import { stripInternalFields } from "#src/backend/extensions/steps/step-handler";
import { withSpan } from "#src/backend/lib/telemetry";
import { BUILT_IN_ACTION_IDS } from "@rova/shared/actions/built-in-actions";
import type { NodeSteps, StepResult } from "@rova/shared/actions/step-result";
import type { ConditionBranch, WorkflowNode } from "@rova/shared/graph/types";
import { isEventSplitNode } from "@rova/shared/lifecycle/event-split";
import { LIFECYCLE_STARTED_HANDLE } from "@rova/shared/lifecycle/lifecycle-outlets";
import { type JsonObject, readJsonValue } from "@rova/shared/types/json";
import { getErrorMessageAsync } from "@rova/shared/utils";
import type { WorkflowActions } from "#src/backend/engine/actions";
import type { CancelBoundary } from "#src/backend/engine/cancel-boundary";
import {
  conditionLogger,
  evaluateConditionExpression,
} from "#src/backend/engine/conditions";
import {
  type ExecutionResult,
  executionData,
  executionError,
  type NodeOutputs,
  type RunLogger,
} from "#src/backend/engine/contracts";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import { type NodeContext, runWithStepLog } from "#src/backend/engine/step-log";
import type { WorkflowStore } from "#src/backend/engine/store";
import {
  processTemplates,
  resolveTemplateString,
} from "#src/backend/engine/templates";
import type { Traversal, TraversalRoute } from "#src/backend/engine/traversal";
import { executeWaitAction } from "#src/backend/engine/wait";

/**
 * What a node's work reports back to the traversal: the routing facts the
 * scheduler needs and nothing else.
 */
type NodeWorkOutcome = {
  result: ExecutionResult;
  /** Action node without an actionType: recorded as failed, no output stored. */
  unconfigured?: boolean;
  /**
   * The branch a Condition node picked. Absent on every other node, and absent
   * on a disabled Condition node, which evaluated nothing and halts its branch
   * where it stands.
   */
  conditionValue?: boolean;
  /**
   * Whether the run stops below this node. A Wait that was skipped or woken by
   * a cancel says so, a disabled routing node says so, and a branch that was
   * handed to a durable run of its own says so because that run already walked
   * everything underneath.
   */
  haltBranch?: boolean;
};

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

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
 * What the action dispatch hands back to the traversal.
 *
 * Every action answers with a `StepResult`. A Condition node also reports the
 * branch it picked: the engine evaluates the expression here, so the boolean is
 * already in hand and the traversal never has to read it back out of the
 * payload the step logged.
 */
type ActionStepOutcome = {
  result: StepResult;
  conditionValue?: boolean;
};

/**
 * Which edges a finished node hands the run along.
 *
 * Two nodes are the exception to following every edge. A normal start leaves the
 * entry node by the Started outlet, and the Canceled outlet's branch is reached
 * only by a run a Cancel Event claimed. An Event Split leaves by the outlet
 * naming the Event the run arrived on. A disabled action node decided nothing,
 * so it fans out like any other. `runNodeWork` halts a disabled routing node's
 * branch, so every node reaching here is one the run is travelling through. The
 * Condition node is decided above this, because its branch is a value its own
 * step produced.
 */
function downstreamRoute(
  node: WorkflowNode,
  eventName: string | null
): TraversalRoute {
  if (node.data.type === "lifecycle") {
    return { kind: "outlet", outlet: LIFECYCLE_STARTED_HANDLE };
  }

  if (isEventSplitNode(node)) {
    return { kind: "event", eventName };
  }

  return { kind: "all" };
}

/** The action id this node runs, absent on a node that runs no action. */
function actionTypeOf(node: WorkflowNode): string | undefined {
  return node.data.type === "action"
    ? readConfigString(node.data.config, "actionType")
    : undefined;
}

/** Whether this node is the one that suspends the run. */
function isWaitNode(node: WorkflowNode): boolean {
  return actionTypeOf(node) === BUILT_IN_ACTION_IDS.wait;
}

function isConditionNode(node: WorkflowNode): boolean {
  return actionTypeOf(node) === BUILT_IN_ACTION_IDS.condition;
}

/**
 * Whether this node's own outcome picks which of its edges the run takes. A
 * Condition evaluates its expression and leaves by `true` or `false`; an Event
 * Split leaves by the outlet naming the Event that arrived.
 *
 * A Lifecycle Node also has named outlets and is excluded, because what picks
 * its outlet is how the run started and whether a Cancel Event claimed it,
 * neither of which is the node's own work.
 *
 * Disabled, such a node decides nothing, and every edge below it stays a branch
 * it would have chosen between, so its branch stops there: following all of
 * them at once is how both sides of a Condition reach the same person.
 */
function isRoutingNode(node: WorkflowNode): boolean {
  return isConditionNode(node) || isEventSplitNode(node);
}

/** Everything the dispatch below needs from the run it is part of. */
type ActionStepInput = {
  actionType: string;
  config: Record<string, unknown>;
  outputs: NodeOutputs;
  context: NodeContext;
  store: WorkflowStore;
  actions: WorkflowActions;
  runtime: WorkflowExecutionRuntime;
  /** The Event that put the run on the branch this node sits on. */
  eventName: string | null;
};

/**
 * Execute a single action step, with the run log rows around it.
 *
 * A step is handed the integration id and never the credentials themselves, so
 * nothing that writes this input down -- the run log below, Inngest's own
 * observability -- has a secret to write. The step fetches what it needs by that
 * id, in memory.
 */
function executeActionStep(input: ActionStepInput): Promise<ActionStepOutcome> {
  return withSpan(
    "rova.workflow.action.execute",
    {
      "rova.action.type": input.actionType,
      "rova.node.id": input.context.nodeId,
      "rova.node.name": input.context.nodeName,
    },
    () => executeActionStepInner(input)
  );
}

async function executeActionStepInner(
  input: ActionStepInput
): Promise<ActionStepOutcome> {
  const { actionType, config, outputs, context, store, actions, runtime } =
    input;

  const stepInput: Record<string, unknown> = {
    ...config,
    _context: context,
  };

  // The Condition action evaluates its expression here, against the outputs of
  // the nodes upstream. The decision is what the run log records and what the
  // traversal routes on, so it is computed once and travels both ways.
  if (actionType === BUILT_IN_ACTION_IDS.condition) {
    const originalExpression = stepInput.condition;
    const { result: evaluatedCondition } = evaluateConditionExpression(
      originalExpression,
      outputs,
      config.conditionModel,
      input.eventName
    );
    conditionLogger.debug("Condition evaluation result", {
      evaluatedCondition,
    });

    const result = await runWithStepLog(
      {
        store,
        context,
        runtime,
        input: {
          condition: evaluatedCondition,
          ...(typeof originalExpression === "string"
            ? { expression: originalExpression }
            : {}),
        },
      },
      () =>
        Promise.resolve({
          success: true,
          data: { condition: evaluatedCondition },
        })
    );

    return { result, conditionValue: evaluatedCondition };
  }

  // An Event Split decides nothing of its own: the Event the run arrived on is
  // already known, and the outlet it names is what the traversal routes along.
  // The row exists so a run's trace says which Event sent it down which branch.
  if (actionType === BUILT_IN_ACTION_IDS.eventSplit) {
    const result = await runWithStepLog(
      { store, context, runtime, input: { event: input.eventName } },
      () => Promise.resolve({ success: true, data: { event: input.eventName } })
    );

    return { result };
  }

  const stepFunction = actions.stepFor(actionType);
  if (!stepFunction) {
    // No row is written for an action nothing implements: there is no node work
    // to record, and the failure is reported by the traversal instead.
    return {
      result: {
        success: false,
        error: {
          message: `Unknown action type: "${actionType}". No action with this id was assembled: no integration, no host action, and none of the built-ins, which are ${Object.values(BUILT_IN_ACTION_IDS).join(", ")}.`,
        },
      },
    };
  }

  // Rova namespaces the id, so an author writes "post" and two nodes running
  // the same action do not write to one another's memoized result.
  const steps: NodeSteps = {
    run: (stepId, work) =>
      runtime.run(`node:${context.nodeId}:${stepId}`, work),
  };

  const result = await runWithStepLog(
    // The rows carry the input as the node was configured, minus the three keys
    // the engine's own dispatch owns.
    { store, context, runtime, input: stripInternalFields(stepInput) },
    () => Promise.resolve(stepFunction(stepInput, steps))
  );

  return { result };
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
   * The Wait node this run was handed, on a run that is itself a branch. It is
   * the one Wait this run enters in place rather than hands on again, which is
   * what stops a branch from handing itself off forever.
   */
  branchEntryNodeId?: string;
  logger: RunLogger;
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

  constructor(input: NodeSchedulerInput) {
    this.input = input;
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
   * has taken the Canceled outlet, and the Start Event before that. A run
   * nothing named an Event for answers null, which a rule compares false
   * against.
   */
  private currentEventName(): string | null {
    return (
      this.input.cancelBoundary.canceledByEvent() ?? this.input.startEventName
    );
  }

  // The persisted graph is validated as a DAG before execution, so we avoid
  // per-call cycle-tracking allocations on this hot path.
  async executeNode(nodeId: string) {
    const { traversal, actions, logger } = this.input;

    const nodeLogger = logger.with({ nodeId });
    nodeLogger.debug("Executing node");

    if (traversal.isCompleted(nodeId)) {
      nodeLogger.debug("Skipping node already completed");
      return;
    }

    const node = traversal.getNode(nodeId);
    if (!node) {
      nodeLogger.warn("Node not found");
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
      nodeLogger.debug(
        "Holding wait node until every other branch has drained"
      );
      return;
    }

    const nodeName = getNodeName(node, actions);
    const actionType = actionTypeOf(node);
    const namedNodeLogger = nodeLogger.with({
      nodeName,
      nodeType: node.data.type,
    });

    const ran = await traversal.withNodeInProgress(nodeId, () =>
      withSpan(
        "rova.workflow.node.execute",
        {
          "rova.node.id": nodeId,
          "rova.node.name": nodeName,
          "rova.node.type": node.data.type,
          "rova.action.type": actionType,
        },
        () => this.executeNodeInner(nodeId, node, nodeName, namedNodeLogger)
      )
    );

    if (!ran) {
      nodeLogger.debug("Skipping node already in progress");
    }
  }

  /**
   * The node's own work: the Lifecycle Node's step, the action step, or the wait.
   *
   * It schedules no downstream node. A handler's own `step.run` calls are steps,
   * and Inngest forbids nesting one step inside another, so what the traversal
   * needs afterwards travels back in the returned outcome.
   */
  private async runNodeWork(
    node: WorkflowNode,
    nodeName: string,
    namedNodeLogger: RunLogger
  ): Promise<NodeWorkOutcome> {
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

    // A disabled node emits a null output, which keeps a template below it
    // resolving. A disabled routing node also stops its branch, for the reason
    // `isRoutingNode` gives.
    if (node.data.enabled === false) {
      const haltBranch = isRoutingNode(node);
      namedNodeLogger.info("Skipping disabled node", { haltBranch });
      return { result: { success: true, data: null }, haltBranch };
    }

    let result: ExecutionResult = {
      success: false,
      error: { message: "Node execution did not produce a result." },
    };
    let conditionValue: boolean | undefined;
    let haltBranch = false;

    if (node.data.type === "lifecycle") {
      namedNodeLogger.debug("Executing lifecycle node");

      // The entry node's output is the payload and nothing else. The Event's own
      // schema validated it at intake, which is the only gate it passes through,
      // and a key the engine added here would shadow a payload field of the same
      // name.
      const lifecycleData: JsonObject = startPayload;

      const lifecycleContext: NodeContext = {
        executionId,
        nodeId: node.id,
        nodeName,
        nodeType: node.data.type,
      };

      // The entry node does no work, and its row exists so that a run's timeline
      // opens with the payload it started from.
      const lifecycleResult = await runWithStepLog(
        {
          store,
          context: lifecycleContext,
          runtime,
          input: { lifecycleData },
        },
        () => Promise.resolve({ success: true as const, data: lifecycleData })
      );

      result = lifecycleResult;
    } else if (node.data.type === "action") {
      const config = node.data.config || {};
      const actionType = readConfigString(config, "actionType");
      const actionLogger = namedNodeLogger.with({
        actionType: actionType ?? null,
      });
      actionLogger.debug("Executing action node");

      if (!actionType) {
        actionLogger.error("Action node missing action type");
        return {
          result: {
            success: false,
            error: {
              message: `Action node "${node.data.label || node.id}" has no action type configured`,
            },
          },
          unconfigured: true,
        };
      }

      // The Condition node's expression is held out of template resolution and
      // put back. It cannot say so with a `literal` field the way every other
      // action does, because `built-ins.ts` gives Condition no config fields at
      // all: the editor draws it with a bespoke panel. The key is deleted rather
      // than emptied, because a config key present and holding `undefined` fails
      // a step's config decode.
      const { condition: originalCondition, ...configWithoutCondition } =
        config;

      const processedConfig = processTemplates(
        configWithoutCondition,
        traversal.outputs,
        new Set(actions.metadataFor(actionType)?.literalConfigKeys ?? [])
      );

      if (originalCondition !== undefined) {
        processedConfig.condition = originalCondition;
      }

      const stepContext: NodeContext = {
        executionId,
        nodeId: node.id,
        nodeName: getNodeName(node, actions),
        nodeType: actionType,
        runMode,
      };
      actionLogger.debug("Calling executeActionStep");

      // The Wait action is the one action the engine runs itself, so it answers
      // with the branch-halting decision the durable runtime made. A step cannot
      // say that, so the value below is rebuilt rather than passed on.
      if (actionType === BUILT_IN_ACTION_IDS.wait) {
        if (!this.entersInPlace(node.id)) {
          return await this.handOffBranch(node, actionLogger);
        }

        const waitOutcome = await executeWaitAction({
          config: processedConfig,
          context: stepContext,
          runtime,
          store,
          workflowId,
          workflowRunId,
          resolveTemplates: (value) =>
            resolveTemplateString(value, traversal.outputs),
        });

        const waitResult = waitOutcome.result;
        if (waitResult.success) {
          // The whole envelope becomes the node's output, as it does for every
          // other action, so a template behind a Wait addresses the wait's own
          // fields rather than reaching through `data`.
          result = { success: true, data: waitResult };
          haltBranch = waitOutcome.haltBranch;
        } else {
          actionLogger.error("Wait failed", {
            nodeId: node.id,
            nodeLabel: node.data.label,
            error: waitResult.error.message,
          });
          result = { success: false, error: waitResult.error };
        }
      } else {
        const actionOutcome = await executeActionStep({
          actionType,
          config: processedConfig,
          outputs: traversal.outputs,
          context: stepContext,
          runtime,
          store,
          actions,
          eventName: this.currentEventName(),
        });

        // Set by a Condition node and by nothing else, which is what the
        // traversal below routes on.
        conditionValue = actionOutcome.conditionValue;

        const stepResult = actionOutcome.result;
        if (stepResult.success) {
          // The whole envelope becomes the node's output, which is what
          // `unwrapStepOutput` reaches through on the far side: a template
          // addresses the payload's own fields and never `data`.
          result = { success: true, data: stepResult };
        } else {
          actionLogger.error("Action step failed", {
            actionType,
            nodeId: node.id,
            nodeLabel: node.data.label,
            error: stepResult.error.message,
          });
          result = { success: false, error: stepResult.error };
        }
      }
    } else {
      namedNodeLogger.error("Unknown node type");
      result = {
        success: false,
        error: {
          message: `Unknown node type "${node.data.type}" in node "${node.data.label || node.id}". Expected "lifecycle" or "action".`,
        },
      };
    }

    return { result, conditionValue, haltBranch };
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
  private async handOffBranch(
    node: WorkflowNode,
    namedNodeLogger: RunLogger
  ): Promise<NodeWorkOutcome> {
    const { traversal, runtime } = this.input;

    namedNodeLogger.info("Handing the branch below this wait to its own run");
    const handoff = await runtime.startBranch?.(`branch-${node.id}`, {
      entryNodeId: node.id,
      releasedNodeIds: traversal.releasedNodeIds,
    });
    if (!handoff) {
      throw new Error(
        `Node "${node.id}" was handed off to a branch run by a runtime that starts none.`
      );
    }

    if (handoff.status === "killed") {
      // The cancellation killed the branch where it stood. Its rows are closed
      // here, and the boundary read below this node is what routes the run.
      await this.sweepKilledBranchWork();
      namedNodeLogger.info("Branch run was cancelled");
      return {
        result: { success: true, data: { branchCancelled: true } },
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
  }

  /**
   * Closes every row of this run still open, which is what a killed branch
   * leaves behind: its node rows and its wait states.
   *
   * The ordering is the whole of what makes this safe, so it is stated here.
   * It runs after the kill has been observed, when no branch run is alive to
   * write to those rows, and before the Canceled outlet is entered, since a
   * Canceled branch opening with a one-week Wait would otherwise leave a killed
   * node reading Running for a week. One event kills every branch of a run at
   * once, which is why closing all of them at the first observed kill closes
   * nothing that is still going.
   *
   * Two killed branches resolving in one pass both reach this, since neither has
   * been memoized yet. The write is idempotent, and the step id keeps a later
   * replay from repeating it.
   */
  private async sweepKilledBranchWork(): Promise<void> {
    const { runtime, store, executionId } = this.input;
    await runtime.run("branch-kill-sweep", async () => {
      await store.cancelOpenWork({ executionId });
      return null;
    });
  }

  /**
   * Records a node's outcome and schedules its downstream branches.
   */
  private async executeNodeInner(
    nodeId: string,
    node: WorkflowNode,
    nodeName: string,
    namedNodeLogger: RunLogger
  ) {
    const { traversal, cancelBoundary } = this.input;

    try {
      const outcome = await this.runNodeWork(node, nodeName, namedNodeLogger);
      const { result } = outcome;

      // A node with no action type never produced an output, so it is recorded
      // as failed without becoming available to downstream templates.
      if (outcome.unconfigured) {
        traversal.recordResult(nodeId, result);
        return;
      }

      // A step result crosses Inngest's memoization boundary as JSON, so this is
      // where it becomes JSON again for the template resolver and the CEL
      // context to walk.
      const payload = executionData(result);
      const outputData = readJsonValue(payload);
      if (outputData === null && payload !== null) {
        namedNodeLogger.warn(
          "Node output is not JSON and will read as empty downstream",
          { actionType: node.data.config?.actionType }
        );
      }
      traversal.markCompleted(nodeId, result, {
        label: node.data.label || nodeId,
        data: outputData,
      });

      namedNodeLogger.info("Node execution completed", {
        success: result.success,
        haltBranch: outcome.haltBranch === true,
        error: executionError(result),
      });

      // A claimed run takes the Canceled outlet instead of whatever came next,
      // and a node that finishes after that stops where it stands.
      const cancel = await cancelBoundary.settle(nodeId);
      if (cancel.entered) {
        await this.runAll(cancel.nextNodes);
        return;
      }

      if (result.success) {
        let shouldContinueDownstream = true;

        if (outcome.haltBranch) {
          namedNodeLogger.info(
            "Skipping downstream nodes because step requested halt"
          );
          shouldContinueDownstream = false;
        }

        if (isConditionNode(node) && shouldContinueDownstream) {
          const conditionResult = outcome.conditionValue;
          namedNodeLogger.debug("Condition node result", {
            conditionResult,
          });

          if (conditionResult !== true && conditionResult !== false) {
            namedNodeLogger.debug(
              "Condition result missing boolean value, skipping downstream nodes"
            );
          } else {
            const nextBranch: ConditionBranch = conditionResult
              ? "true"
              : "false";
            const nextNodes = traversal.nextNodes(nodeId, {
              kind: "condition",
              branch: nextBranch,
            });
            namedNodeLogger.debug(
              "Condition branch selected, executing downstream nodes in parallel",
              {
                selectedBranch: nextBranch,
                nextNodeCount: nextNodes.length,
                nextNodeIds: nextNodes,
              }
            );
            traversal.markReadyForDownstream(nodeId);
            await this.runAll(nextNodes);
          }
        } else if (shouldContinueDownstream) {
          const nextNodes = traversal.nextNodes(
            nodeId,
            downstreamRoute(node, this.currentEventName())
          );
          namedNodeLogger.debug("Executing downstream nodes in parallel", {
            nextNodeCount: nextNodes.length,
            nextNodeIds: nextNodes,
          });
          traversal.markReadyForDownstream(nodeId);
          await this.runAll(nextNodes);
        }
      }
    } catch (error) {
      // Every error escaping a node is that node's failure, and the run carries
      // on with its siblings. A cancellation never arrives this way: Rova's own
      // is the flag the cancel boundary reads, and Inngest stops calling a
      // cancelled function rather than throwing into it.
      namedNodeLogger.error("Unexpected error executing node", {
        error,
      });
      const errorMessage = await getErrorMessageAsync(error);
      // The node's own row was already closed with this error on its way out of
      // `runWithStepLog`, so what is left here is recording the failure for the
      // traversal. No output: the node handed nothing on.
      traversal.markCompleted(nodeId, {
        success: false,
        error: { message: errorMessage },
      });
    }
  }

  /** Runs a set of nodes side by side, which is how every branch fans out. */
  runAll(nodeIds: readonly string[]): Promise<void[]> {
    return Promise.all(nodeIds.map((nodeId) => this.executeNode(nodeId)));
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
  async drainDeferredWaits(): Promise<void> {
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
      // eslint-disable-next-line eslint/no-await-in-loop -- a round has to resume before the graph can say whether it reached another wait
      await this.runAll(batch);
    }
  }
}
