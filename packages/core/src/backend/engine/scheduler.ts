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
   * on a disabled Condition node, which evaluated nothing and therefore fans
   * out to every branch below it.
   */
  conditionValue?: boolean;
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
 * naming the Event the run arrived on. A disabled node decided nothing, so it
 * fans out like any other. The Condition node is decided above this, because its
 * branch is a value its own step produced.
 */
function downstreamRoute(
  node: WorkflowNode,
  eventName: string | null
): TraversalRoute {
  if (node.data.type === "lifecycle") {
    return { kind: "outlet", outlet: LIFECYCLE_STARTED_HANDLE };
  }

  if (node.data.enabled !== false && isEventSplitNode(node)) {
    return { kind: "event", eventName };
  }

  return { kind: "all" };
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
  logger: RunLogger;
};

export class NodeScheduler {
  private readonly input: NodeSchedulerInput;

  constructor(input: NodeSchedulerInput) {
    this.input = input;
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

    const { dependencies, missing } = traversal.dependenciesOf(nodeId);
    if (missing.length > 0) {
      nodeLogger.debug("Waiting for dependencies before execution", {
        dependencies,
        missingDependencies: missing,
      });
      return;
    }

    const nodeName = getNodeName(node, actions);
    const actionType =
      node.data.type === "action"
        ? readConfigString(node.data.config, "actionType")
        : undefined;
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

    // Disabled nodes emit a null output so downstream templates don't hard-fail.
    if (node.data.enabled === false) {
      namedNodeLogger.info("Skipping disabled node");
      return { result: { success: true, data: null } };
    }

    let result: ExecutionResult = {
      success: false,
      error: { message: "Node execution did not produce a result." },
    };
    let conditionValue: boolean | undefined;

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
        const waitResult = await executeWaitAction({
          config: processedConfig,
          context: stepContext,
          runtime,
          store,
          workflowId,
          workflowRunId,
          resolveTemplates: (value) =>
            resolveTemplateString(value, traversal.outputs),
        });

        if (waitResult.success) {
          result = {
            success: true,
            data: waitResult,
            haltBranch: waitResult.haltBranch === true,
          };
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

    return { result, conditionValue };
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
        haltBranch: result.success && result.haltBranch === true,
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

        if (result.haltBranch) {
          namedNodeLogger.info(
            "Skipping downstream nodes because step requested halt"
          );
          shouldContinueDownstream = false;
        }

        // A disabled Condition node evaluated nothing, so it fans out to every
        // branch instead of picking one.
        const isConditionNode =
          node.data.enabled !== false &&
          node.data.type === "action" &&
          node.data.config?.actionType === BUILT_IN_ACTION_IDS.condition;

        if (isConditionNode && shouldContinueDownstream) {
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
}
