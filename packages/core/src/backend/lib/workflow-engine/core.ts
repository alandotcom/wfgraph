/**
 * Workflow executor used by Inngest runtime.
 * Keeps node execution, templating, and logging behavior aligned with the builder.
 */

import { evaluateCompiledCondition } from "#src/backend/lib/cel/condition-payload";
import { getAppLogger } from "#src/backend/lib/logger";
import { stripInternalFields } from "#src/backend/lib/steps/step-handler";
import { withSpan } from "#src/backend/lib/telemetry";
import {
  type JsonObject,
  type JsonValue,
  readJsonValue,
} from "@rova/shared/types/json";
import { getErrorMessageAsync } from "@rova/shared/utils";
import { normalizeConditionBranch } from "@rova/shared/workflow/condition-branch";
import {
  collectTimestampFieldPaths,
  parseConditionModel,
} from "@rova/shared/workflow/conditions";
import { toWorkflowGraphData } from "@rova/shared/workflow/graph";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
  type LifecycleOutlet,
  nodesBehindOutlet,
} from "@rova/shared/workflow/lifecycle-outlets";
import {
  parseTemplate,
  resolveOutputPath,
  type TemplateToken,
  unwrapStepOutput,
} from "@rova/shared/workflow/node-references";
import type { StepResult } from "@rova/shared/workflow/step-result";
import type {
  ConditionBranch,
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from "@rova/shared/workflow/types";
import { noWorkflowActions, type WorkflowActions } from "./actions";
import {
  createInMemoryWorkflowRuntime,
  type WorkflowExecutionRuntime,
} from "./runtime";
import { type NodeContext, runWithStepLog } from "./step-log";
import {
  noopWorkflowStore,
  type PendingCancel,
  type WorkflowRunAuditEventType,
  type WorkflowStore,
} from "./store";
import { executeWaitAction } from "./wait";

export type { WorkflowActions } from "./actions";
export type { WorkflowExecutionRuntime } from "./runtime";
export type { WorkflowStore } from "./store";

/**
 * Action type of the built-in Wait step. The executor dispatches on this value
 * to reach `executeWaitAction`, and the same check keeps Wait nodes out of the
 * node-level step wrapper (Wait suspends the run, and Inngest forbids a sleep
 * or a wait inside a step).
 */
const WAIT_ACTION_TYPE = "Wait";

/**
 * What one node left behind, as the traversal reads it. `haltBranch` is how a
 * node that succeeded says nothing below it should run, which is what a skipped
 * Wait answers with.
 */
export type ExecutionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  haltBranch?: boolean;
};

/**
 * What each finished node left behind, keyed by node id.
 *
 * `data` is JSON because it has already crossed a serialization boundary by the
 * time anything reads it: Inngest memoizes a step's return value between steps,
 * and a resumed run reads back what it decoded. Saying so here is what lets the
 * template resolver and the CEL context walk a value with plain language checks
 * rather than a hand-rolled shape predicate.
 */
type NodeOutputs = Record<string, { label: string; data: JsonValue }>;

/**
 * What a node's memoized work reports back to the traversal. It travels through
 * the durable runtime (and therefore through JSON), so it carries only the
 * routing facts the scheduler needs, never live objects or callbacks.
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

export type WorkflowExecutionInput = {
  graph: SerializedWorkflowGraph;
  /**
   * The payload that set this run going: a webhook body, a manual-run input, or
   * the data on an Inngest event. It reached the engine as JSON and is written
   * back out as JSON into `workflow_executions.input`.
   */
  triggerInput?: JsonObject;
  /** The untouched payload as it arrived, before any mock request filled in. */
  requestPayload?: JsonObject;
  /**
   * Identifies the run row every log, timeline event, and wait state hangs off.
   * Required: whether a run leaves a trace is decided by which `WorkflowStore`
   * the caller injects, never by omitting an id here.
   */
  executionId: string;
  /** Owning workflow. Also how steps look up integration credentials. */
  workflowId: string;
  workflowName?: string;
  workflowRunId?: string;
  runMode?: "live" | "test";
  eventContext?: {
    eventType?: string;
    correlationKey?: string;
  };
};

const workflowExecutorLogger = getAppLogger("workflow", "executor");
const conditionLogger = workflowExecutorLogger.getChild("condition");

type ConditionEvalResult = {
  result: boolean;
};

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

function getConditionNextNodeIds(input: {
  edges: WorkflowEdge[];
  branch: ConditionBranch;
}): string[] {
  return input.edges
    .filter(
      (edge) => normalizeConditionBranch(edge.sourceHandle) === input.branch
    )
    .map((edge) => edge.target);
}

/**
 * The entry-node edges leaving one of the Lifecycle Node's outlets.
 *
 * An edge that names neither is followed by no run: the save refuses one, and
 * binding it by render order is what naming the outlets was meant to stop.
 */
function getLifecycleNextNodeIds(input: {
  edges: WorkflowEdge[];
  outlet: LifecycleOutlet;
}): string[] {
  return input.edges
    .filter((edge) => edge.sourceHandle === input.outlet)
    .map((edge) => edge.target);
}

/** Key a node's output is stored and looked up under. */
function outputKey(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9]/g, "_");
}

/** Whether this node is the Wait step, which the engine runs itself. */
function isWaitNode(node: WorkflowNode): boolean {
  return (
    node.data.type === "action" &&
    readConfigString(node.data.config, "actionType") === WAIT_ACTION_TYPE
  );
}

/**
 * Fold one node's output into the flat namespace a CEL condition reads from.
 *
 * Steps return their fields inside a `{ success, data }` wrapper, and a condition
 * names those fields by path alone (`payload.donorId == "abc"`), so the output goes
 * through the same unwrapping a template token gets before its keys are lifted into
 * the namespace.
 *
 * Known hazard, deliberately left alone: the namespace is flat across every node,
 * so two nodes that both produce a field called `id` collide, and the node that
 * runs later wins. Node-qualifying it would mean naming a node in every rule.
 */
function mergeConditionContextValue(context: JsonObject, value: JsonValue) {
  const record = unwrapStepOutput(value);
  // A node output is JSON that came back from a plugin's own API call, so its
  // shape belongs to that API and nothing here knows it. Only a keyed object
  // contributes names: copying a string or an array would spread index keys
  // into the namespace and let a condition read `0`.
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return;
  }

  Object.assign(context, record);

  const nestedInput = Reflect.get(record, "input");
  if (
    typeof nestedInput !== "object" ||
    nestedInput === null ||
    Array.isArray(nestedInput)
  ) {
    return;
  }

  for (const key of Object.keys(nestedInput)) {
    if (!(key in context)) {
      context[key] = Reflect.get(nestedInput, key);
    }
  }
}

/**
 * The timestamp field paths a Condition node's stored model declares.
 *
 * Saving a workflow rejects a Condition node whose model is missing or does not
 * compile to the expression beside it, so a model that fails to parse here
 * belongs to a node that never should have run; the condition still evaluates,
 * against a context where timestamps stay strings.
 */
function readConditionTimestampPaths(conditionModel: unknown): string[] {
  const parsed = parseConditionModel(conditionModel);
  if (!parsed.valid) {
    conditionLogger.warn("Condition model did not parse", {
      error: parsed.error,
    });
    return [];
  }

  return collectTimestampFieldPaths(parsed.model);
}

/**
 * Evaluate CEL condition expression against workflow output context.
 */
function evaluateConditionExpression(
  conditionExpression: unknown,
  outputs: NodeOutputs,
  conditionModel: unknown
): ConditionEvalResult {
  conditionLogger.debug("Evaluating condition expression", {
    conditionExpression,
  });

  if (typeof conditionExpression === "boolean") {
    return { result: conditionExpression };
  }

  if (typeof conditionExpression !== "string") {
    conditionLogger.warn("Condition is neither boolean nor string", {
      conditionExpression,
    });
    return { result: false };
  }

  const expression = conditionExpression.trim();
  if (!expression) {
    return { result: false };
  }

  const merged: JsonObject = {};
  for (const output of Object.values(outputs)) {
    mergeConditionContextValue(merged, output.data);
  }

  const evaluation = evaluateCompiledCondition({
    expression,
    timestampPaths: readConditionTimestampPaths(conditionModel),
    payload: merged,
  });

  if (!evaluation.ok) {
    conditionLogger.error("CEL condition evaluation failed", {
      error: evaluation.error,
      conditionExpression,
    });
    return { result: false };
  }

  return { result: evaluation.value };
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

/** Everything the dispatch below needs from the run it is part of. */
type ActionStepInput = {
  actionType: string;
  config: Record<string, unknown>;
  outputs: NodeOutputs;
  context: NodeContext;
  store: WorkflowStore;
  actions: WorkflowActions;
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
  const { actionType, config, outputs, context, store, actions } = input;

  const stepInput: Record<string, unknown> = {
    ...config,
    _context: context,
  };

  // The Condition action evaluates its expression here, against the outputs of
  // the nodes upstream. The decision is what the run log records and what the
  // traversal routes on, so it is computed once and travels both ways.
  if (actionType === "Condition") {
    const originalExpression = stepInput.condition;
    const { result: evaluatedCondition } = evaluateConditionExpression(
      originalExpression,
      outputs,
      config.conditionModel
    );
    conditionLogger.debug("Condition evaluation result", {
      evaluatedCondition,
    });

    const result = await runWithStepLog(
      {
        store,
        context,
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

  const stepFunction = actions.stepFor(actionType);
  if (!stepFunction) {
    // No row is written for an action nothing implements: there is no node work
    // to record, and the failure is reported by the traversal instead.
    return {
      result: {
        success: false,
        error: {
          message: `Unknown action type: "${actionType}". No action with this id was assembled: no integration, no host action, and none of the built-ins, which are ${actions.systemActionIds.join(", ")}.`,
        },
      },
    };
  }

  const result = await runWithStepLog(
    // The rows carry the input as the node was configured, minus the three keys
    // the engine's own dispatch owns.
    { store, context, input: stripInternalFields(stepInput) },
    () => Promise.resolve(stepFunction(stepInput))
  );

  return { result };
}

/**
 * Render a resolved value back into the surrounding template string. Objects and
 * arrays become JSON so a whole node output can be dropped into a text field.
 * A missing value renders as empty text, which is what an upstream node that was
 * disabled or that failed to produce the field leaves behind.
 */
function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${value}`;
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  return "";
}

function resolveTemplateToken(
  token: TemplateToken,
  outputs: NodeOutputs
): string {
  const output = outputs[outputKey(token.nodeId)];
  if (!output) {
    // The token names a node that has not run, so the authored text stays put.
    return token.raw;
  }

  return stringifyTemplateValue(
    resolveOutputPath(output.data, token.fieldPath)
  );
}

/**
 * Replace every `{{@nodeId:Label.field}}` reference in the config's string values
 * with the upstream value it names.
 *
 * Both the grammar and the path walking come from `node-references`, the module
 * the editor's autocomplete builds its suggestions with, so a path it offers
 * (`items[0].name`, say) resolves to the same value here at run time.
 *
 * A key holding `undefined` is dropped rather than carried, because a step decodes
 * its config through its schema's canonical JSON codec, where an optional field
 * takes an absent key or a null and refuses one present and empty. A builder left
 * the field blank either way.
 */
function processTemplates(
  config: Record<string, unknown>,
  outputs: NodeOutputs
): Record<string, unknown> {
  const processed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) {
      continue;
    }

    processed[key] =
      typeof value === "string" ? resolveTemplateString(value, outputs) : value;
  }

  return processed;
}

/** One authored string with its references replaced. */
function resolveTemplateString(value: string, outputs: NodeOutputs): string {
  return parseTemplate(value)
    .map((segment) =>
      segment.kind === "literal"
        ? segment.text
        : resolveTemplateToken(segment.token, outputs)
    )
    .join("");
}

type ExecutionLogger = ReturnType<typeof workflowExecutorLogger.with>;

/** How a run that reached the end of its graph is worded on the timeline. */
function buildRunCompletedMessage(
  runMode: "live" | "test",
  status: TraversalTerminalStatus
): string {
  if (status === "canceled") {
    return runMode === "test"
      ? "Test mode canceled at the Canceled outlet"
      : "Run canceled at the Canceled outlet";
  }
  if (runMode === "test") {
    return status === "completed"
      ? "Test mode completed successfully"
      : "Test mode completed with errors";
  }
  return status === "completed"
    ? "Run completed successfully"
    : "Run completed with errors";
}

function buildRunFailedMessage(
  runMode: "live" | "test",
  cancelled: boolean
): string {
  if (runMode === "test") {
    return cancelled
      ? "Test mode cancelled"
      : "Test mode failed with fatal error";
  }
  return cancelled
    ? "Run cancelled while waiting"
    : "Run failed with fatal error";
}

/**
 * How a run that walked its graph to the end finished. `canceled` is a run that
 * left the Started branch for the Canceled one, whether or not that branch had
 * anything to run.
 */
type TraversalTerminalStatus = "completed" | "failed" | "canceled";

const RUN_COMPLETED_AUDIT_EVENT = {
  completed: "run_completed",
  failed: "run_failed",
  canceled: "run_cancelled",
} as const satisfies Record<TraversalTerminalStatus, WorkflowRunAuditEventType>;

/**
 * Writes the terminal record and timeline event for a run that finished its
 * graph. Runs inside a durable step, so it must stay side-effect-idempotent
 * from the caller's point of view: nothing here feeds back into the traversal.
 */
async function recordRunCompleted(input: {
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  status: TraversalTerminalStatus;
  output: unknown;
  error?: string;
  startTime: number;
  duration: number;
  resultCount: number;
  runMode: "live" | "test";
  logger: ExecutionLogger;
}) {
  let recorded = true;

  try {
    recorded = await input.store.completeRun({
      executionId: input.executionId,
      status: input.status,
      output: input.output,
      error: input.error,
      startTime: input.startTime,
    });
    input.logger.debug("Updated execution record", { status: input.status });
  } catch (error) {
    input.logger.error("Failed to update execution record", { error });
  }

  // A completion that lost to a cancellation must not announce itself: the
  // timeline's last word has to match the row's terminal status.
  if (recorded) {
    await input.store.recordAuditEvent({
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: RUN_COMPLETED_AUDIT_EVENT[input.status],
      message: buildRunCompletedMessage(input.runMode, input.status),
      metadata: {
        duration: input.duration,
        resultCount: input.resultCount,
        runMode: input.runMode,
      },
    });
  } else {
    input.logger.info("Run completion superseded by cancellation", {
      status: input.status,
    });
  }

  return { status: input.status };
}

/**
 * Terminal record for a run that died on an error escaping the traversal
 * (including a cancellation while waiting).
 */
async function recordRunFailed(input: {
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  status: "failed" | "canceled";
  cancelled: boolean;
  error: string;
  startTime: number;
  runMode: "live" | "test";
  logger: ExecutionLogger;
}) {
  let recorded = true;

  try {
    recorded = await input.store.completeRun({
      executionId: input.executionId,
      status: input.status,
      error: input.error,
      startTime: input.startTime,
    });
  } catch (logError) {
    input.logger.error("Failed to persist fatal execution error", {
      error: logError,
    });
  }

  // Same rule as `recordRunCompleted`: a terminal write this run lost must not
  // announce itself. A superseded run is the case that makes it load-bearing --
  // its row stays `superseded`, and a "Run cancelled" line on the timeline would
  // contradict it.
  if (recorded) {
    await input.store.recordAuditEvent({
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: input.cancelled ? "run_cancelled" : "run_failed",
      message: buildRunFailedMessage(input.runMode, input.cancelled),
      metadata: {
        error: input.error,
        runMode: input.runMode,
      },
    });
  } else {
    input.logger.info("Run failure superseded by an earlier terminal status", {
      status: input.status,
    });
  }

  return { status: input.status };
}

/**
 * Main workflow executor function.
 *
 * All three dependencies are ports the caller supplies: `runtime` decides how
 * work is made durable, `store` decides where the run's trace is written, and
 * `actions` decides what an action id dispatches to. The defaults are the honest
 * in-process choices - work runs inline, nothing is persisted, no action is
 * implemented - so a caller that wants a run recorded must inject a store that
 * records, and one that wants a node to do work must inject a surface. The
 * Inngest adapter in lib/inngest/workflow-function.ts is where a real run picks
 * up all three.
 */
export function executeWorkflow(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime = createInMemoryWorkflowRuntime(),
  store: WorkflowStore = noopWorkflowStore,
  actions: WorkflowActions = noWorkflowActions
) {
  return withSpan(
    "rova.workflow.execution",
    {
      "rova.workflow.id": input.workflowId,
      "rova.execution.id": input.executionId,
      "rova.workflow.name": input.workflowName,
      "rova.execution.run_mode": input.runMode ?? "live",
    },
    () => executeWorkflowInner(input, runtime, store, actions)
  );
}

async function executeWorkflowInner(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions
) {
  const {
    graph,
    triggerInput = {},
    requestPayload,
    executionId,
    workflowId,
    workflowName,
    workflowRunId,
    runMode = "live",
    eventContext,
  } = input;
  const { nodes, edges } = toWorkflowGraphData(graph);

  const currentWorkflowRunId = workflowRunId || runtime.runId || executionId;

  const executionLogger = workflowExecutorLogger.with({
    workflowId,
    workflowName: workflowName ?? null,
    executionId,
    workflowRunId: currentWorkflowRunId,
    runMode,
  });

  executionLogger.info("Starting workflow execution", {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    runMode,
    eventContext,
    triggerInput,
    requestPayload: requestPayload ?? triggerInput,
  });

  const outputs: NodeOutputs = {};
  const results: Record<string, ExecutionResult> = {};
  const workflowStartTime = Date.now();

  // Build node and edge maps
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edgesBySource = new Map<string, WorkflowEdge[]>();
  const edgesByTarget = new Map<string, string[]>();
  for (const edge of edges) {
    const sourceEdges = edgesBySource.get(edge.source) || [];
    sourceEdges.push(edge);
    edgesBySource.set(edge.source, sourceEdges);

    const sources = edgesByTarget.get(edge.target) || [];
    sources.push(edge.source);
    edgesByTarget.set(edge.target, sources);
  }

  // Find trigger nodes
  const nodesWithIncoming = new Set(edges.map((e) => e.target));
  const triggerNodes = nodes.filter(
    (node) => node.data.type === "trigger" && !nodesWithIncoming.has(node.id)
  );

  executionLogger.info("Discovered trigger nodes", {
    triggerNodeCount: triggerNodes.length,
    triggerNodeIds: triggerNodes.map((node) => node.id),
  });

  const completedNodes = new Set<string>();
  const inProgressNodes = new Set<string>();
  const downstreamReadyNodes = new Set<string>();

  // Set the moment the run leaves the Started branch for the Canceled one, and
  // read by every node that finishes after: a run on its way out schedules
  // nothing more on the branch it was walking.
  let enteredCanceledBranch = false;

  // Which side of the lifecycle a node sits on is a fact about the graph rather
  // than about how far this run got, so the boundary read below reaches the same
  // nodes on a replay as on the attempt. A node inside the Canceled branch is
  // asked nothing: its run is already canceled, which is what makes a second
  // Cancel Event a no-op.
  const canceledBranchNodeIds = nodesBehindOutlet({
    entryNodeIds: new Set(triggerNodes.map((node) => node.id)),
    outlet: LIFECYCLE_CANCELED_HANDLE,
    edges,
  });

  // Helper to get a meaningful node name
  function getNodeName(node: WorkflowNode): string {
    if (node.data.label) {
      return node.data.label;
    }
    if (node.data.type === "action") {
      const actionType = readConfigString(node.data.config, "actionType");
      if (actionType) {
        // The label comes from the assembled catalog, so a run log names an action
        // the way the editor does.
        const label = actions.labelFor(actionType);
        if (label) {
          return label;
        }
      }
      return "Action";
    }
    if (node.data.type === "trigger") {
      return "Trigger";
    }
    return node.data.type;
  }

  function getDeterministicTerminalOutput() {
    const terminalNodeIds = nodes
      .filter((node) => (edgesBySource.get(node.id)?.length ?? 0) === 0)
      .map((node) => node.id)
      .toSorted((a, b) => a.localeCompare(b));

    for (const nodeId of terminalNodeIds) {
      const output = results[nodeId]?.data;
      if (output !== undefined) {
        return output;
      }
    }

    const resultKeys = Object.keys(results).toSorted((a, b) =>
      a.localeCompare(b)
    );
    for (const nodeId of resultKeys) {
      const output = results[nodeId]?.data;
      if (output !== undefined) {
        return output;
      }
    }

    return undefined;
  }

  /**
   * Asks whether a Cancel Event has claimed this run, and takes the Canceled
   * outlet if one has. Answers whether the run has left the Started branch, in
   * which case the node that just finished schedules nothing more.
   *
   * The read sits inside a step, so its answer is memoized per node: a replay
   * that asked the database again could route one attempt down the Started
   * branch and the next down the Canceled one, and the memoized node outputs
   * would then belong to neither.
   */
  async function settleCancelBoundary(nodeId: string): Promise<boolean> {
    if (canceledBranchNodeIds.has(nodeId)) {
      return false;
    }

    const pending = await runtime.step(`lifecycle-check-${nodeId}`, () =>
      store.readPendingCancel(executionId)
    );
    if (pending) {
      await enterCanceledBranch(pending);
    }

    return enteredCanceledBranch;
  }

  /**
   * Routes the run into the Lifecycle Node's Canceled outlet.
   *
   * The branch runs inside the same Execution, so every node that already
   * landed keeps its output; what changes is the entry node's, which becomes
   * the payload the canceling Event carried. An outlet with no edge leaves
   * nothing to schedule, and the run ends on the status alone.
   */
  async function enterCanceledBranch(pending: PendingCancel) {
    if (enteredCanceledBranch) {
      return;
    }
    enteredCanceledBranch = true;

    const nextNodes: string[] = [];
    for (const triggerNode of triggerNodes) {
      outputs[outputKey(triggerNode.id)] = {
        label: triggerNode.data.label || triggerNode.id,
        data: pending.payload,
      };
      // The entry node may not have scheduled anything yet, and the branch's
      // first node waits on it the way any node waits on its source.
      downstreamReadyNodes.add(triggerNode.id);
      nextNodes.push(
        ...getLifecycleNextNodeIds({
          edges: edgesBySource.get(triggerNode.id) ?? [],
          outlet: LIFECYCLE_CANCELED_HANDLE,
        })
      );
    }

    executionLogger.info("Entering the Canceled outlet", {
      cancelEventName: pending.eventName,
      nextNodeIds: nextNodes,
    });

    await Promise.all(nextNodes.map((nextNodeId) => executeNode(nextNodeId)));
  }

  // Helper to execute a single node
  // The persisted graph is validated as a DAG before execution, so we avoid
  // per-call cycle-tracking allocations on this hot path.
  async function executeNode(nodeId: string) {
    const nodeLogger = executionLogger.with({ nodeId });
    nodeLogger.debug("Executing node");

    if (completedNodes.has(nodeId)) {
      nodeLogger.debug("Skipping node already completed");
      return;
    }

    if (inProgressNodes.has(nodeId)) {
      nodeLogger.debug("Skipping node already in progress");
      return;
    }

    const node = nodeMap.get(nodeId);
    if (!node) {
      nodeLogger.warn("Node not found");
      return;
    }

    const dependencies = edgesByTarget.get(nodeId) ?? [];
    const missingDependencies = dependencies.filter(
      (dependency) => !downstreamReadyNodes.has(dependency)
    );
    if (missingDependencies.length > 0) {
      nodeLogger.debug("Waiting for dependencies before execution", {
        dependencies,
        missingDependencies,
      });
      return;
    }

    inProgressNodes.add(nodeId);
    const nodeName = getNodeName(node);
    const actionType =
      node.data.type === "action"
        ? readConfigString(node.data.config, "actionType")
        : undefined;
    const namedNodeLogger = nodeLogger.with({
      nodeName,
      nodeType: node.data.type,
    });

    try {
      await withSpan(
        "rova.workflow.node.execute",
        {
          "rova.node.id": nodeId,
          "rova.node.name": nodeName,
          "rova.node.type": node.data.type,
          "rova.action.type": actionType,
        },
        () => executeNodeInner(nodeId, node, nodeName, namedNodeLogger)
      );
    } finally {
      inProgressNodes.delete(nodeId);
    }
  }

  /**
   * The node's own work: the trigger step, the action step, or the wait.
   *
   * This is the unit the durable runtime memoizes, so it deliberately does not
   * schedule downstream nodes - Inngest forbids nesting one step inside
   * another. Whatever the traversal needs afterwards travels back in the
   * returned outcome, which crosses a step boundary and stays JSON-safe.
   */
  async function runNodeWork(
    node: WorkflowNode,
    nodeName: string,
    namedNodeLogger: ReturnType<typeof executionLogger.with>
  ): Promise<NodeWorkOutcome> {
    // Disabled nodes emit a null output so downstream templates don't hard-fail.
    if (node.data.enabled === false) {
      namedNodeLogger.info("Skipping disabled node");
      return { result: { success: true, data: null } };
    }

    let result: ExecutionResult = {
      success: false,
      error: "Node execution did not produce a result.",
    };
    let conditionValue: boolean | undefined;

    if (node.data.type === "trigger") {
      namedNodeLogger.debug("Executing trigger node");

      // The entry node's output is the payload and nothing else. The Event's own
      // schema validated it at intake, which is the only gate it passes through,
      // and a key the engine added here would shadow a payload field of the same
      // name.
      const triggerData: JsonObject = triggerInput ?? {};

      const triggerContext: NodeContext = {
        executionId,
        nodeId: node.id,
        nodeName,
        nodeType: node.data.type,
      };

      // The entry node does no work, and its row exists so that a run's timeline
      // opens with the payload it started from.
      const triggerResult = await runWithStepLog(
        {
          store,
          context: triggerContext,
          input: { triggerData },
        },
        () => Promise.resolve({ success: true as const, data: triggerData })
      );

      result = {
        success: triggerResult.success,
        data: triggerResult.data,
      };
    } else if (node.data.type === "action") {
      const config = node.data.config || {};
      const actionType = readConfigString(config, "actionType");
      const actionLogger = namedNodeLogger.with({
        actionType: actionType ?? null,
      });
      actionLogger.debug("Executing action node");

      // Check if action type is defined
      if (!actionType) {
        actionLogger.error("Action node missing action type");
        return {
          result: {
            success: false,
            error: `Action node "${node.data.label || node.id}" has no action type configured`,
          },
          unconfigured: true,
        };
      }

      // Process templates in config, but keep conditions unprocessed for special
      // handling. The key is deleted rather than emptied, because a config key
      // present and holding `undefined` fails a step's config decode.
      const { condition: originalCondition, ...configWithoutCondition } =
        config;

      const processedConfig = processTemplates(configWithoutCondition, outputs);

      // Add back the original condition (unprocessed)
      if (originalCondition !== undefined) {
        processedConfig.condition = originalCondition;
      }

      // In test mode, keep test destination overrides as authored literals. This
      // prevents trigger/runtime payload templates from steering where
      // test-recipient messages are sent. Each is written only where the node has
      // one, since assigning an absent field would put a key holding `undefined`
      // into the config, which a step's config decode refuses.
      if (runMode === "test") {
        if (
          actionType === "resend/send-email" &&
          config.testEmailTo !== undefined
        ) {
          processedConfig.testEmailTo = config.testEmailTo;
        }

        if (
          actionType === "twilio/send-sms" &&
          config.testPhoneTo !== undefined
        ) {
          processedConfig.testPhoneTo = config.testPhoneTo;
        }
      }

      const stepContext: NodeContext = {
        executionId,
        nodeId: node.id,
        nodeName: getNodeName(node),
        nodeType: actionType,
        runMode,
      };
      actionLogger.debug("Calling executeActionStep");

      // The Wait action is the one action the engine runs itself, so its result
      // is an ExecutionResult already and carries the branch-halting decision
      // the durable runtime made. Everything else comes back as a StepResult.
      if (actionType === WAIT_ACTION_TYPE) {
        const waitResult = await executeWaitAction({
          config: processedConfig,
          context: stepContext,
          runtime,
          store,
          workflowId,
          workflowRunId: currentWorkflowRunId,
          resolveTemplates: (value) => resolveTemplateString(value, outputs),
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
            error: waitResult.error,
          });
          result = { success: false, error: waitResult.error };
        }
      } else {
        const actionOutcome = await executeActionStep({
          actionType,
          config: processedConfig,
          outputs,
          context: stepContext,
          store,
          actions,
        });

        // Set by a Condition node and by nothing else, which is what the
        // traversal below routes on.
        conditionValue = actionOutcome.conditionValue;

        const stepResult = actionOutcome.result;
        if (!stepResult.success) {
          const errorMessage = stepResult.error.message;
          actionLogger.error("Action step failed", {
            actionType,
            nodeId: node.id,
            nodeLabel: node.data.label,
            error: errorMessage,
          });
          result = {
            success: false,
            error: errorMessage,
          };
        } else {
          result = {
            success: true,
            data: stepResult,
          };
        }
      }
    } else {
      namedNodeLogger.error("Unknown node type");
      result = {
        success: false,
        error: `Unknown node type "${node.data.type}" in node "${node.data.label || node.id}". Expected "trigger" or "action".`,
      };
    }

    return { result, conditionValue };
  }

  /**
   * Runs a node's work through the durable runtime so a replay reuses the
   * stored result instead of repeating the side effect.
   *
   * Two shapes stay unwrapped: disabled nodes (nothing happens, nothing to
   * remember) and Wait nodes (they suspend the run through runtime.sleep /
   * runtime.waitForEvent, which cannot sit inside a step - executeWaitAction
   * memoizes its own persistence segments around those wait boundaries).
   */
  function runNodeWorkMemoized(
    nodeId: string,
    node: WorkflowNode,
    nodeName: string,
    namedNodeLogger: ReturnType<typeof executionLogger.with>
  ): Promise<NodeWorkOutcome> {
    if (isWaitNode(node) || node.data.enabled === false) {
      return runNodeWork(node, nodeName, namedNodeLogger);
    }

    return runtime.step(`node:${nodeId}`, () =>
      runNodeWork(node, nodeName, namedNodeLogger)
    );
  }

  /**
   * Records a node's outcome and schedules its downstream branches. Runs
   * outside the node's step so descendants become sibling steps rather than
   * nested ones.
   */
  async function executeNodeInner(
    nodeId: string,
    node: WorkflowNode,
    nodeName: string,
    namedNodeLogger: ReturnType<typeof executionLogger.with>
  ) {
    try {
      const outcome = await runNodeWorkMemoized(
        nodeId,
        node,
        nodeName,
        namedNodeLogger
      );
      const { result } = outcome;

      // A node with no action type never produced an output, so it is recorded
      // as failed without becoming available to downstream templates.
      if (outcome.unconfigured) {
        results[nodeId] = result;
        return;
      }

      // Store results
      results[nodeId] = result;

      // Store outputs with sanitized nodeId for template variable lookup.
      // A step's payload arrives as unknown because the dispatch is a dynamic
      // import, so this is where it becomes JSON again for the template
      // resolver and the CEL context to walk.
      const sanitizedNodeId = outputKey(nodeId);
      const outputData = readJsonValue(result.data);
      if (outputData === null && result.data !== null) {
        namedNodeLogger.warn(
          "Node output is not JSON and will read as empty downstream",
          { actionType: node.data.config?.actionType }
        );
      }
      outputs[sanitizedNodeId] = {
        label: node.data.label || nodeId,
        data: outputData,
      };
      completedNodes.add(nodeId);

      namedNodeLogger.info("Node execution completed", {
        success: result.success,
        haltBranch: result.haltBranch === true,
        error: result.error,
      });

      // A claimed run takes the Canceled outlet instead of whatever came next,
      // and a node that finishes after that stops where it stands.
      if (await settleCancelBoundary(nodeId)) {
        return;
      }

      // Execute next nodes
      if (result.success) {
        let shouldContinueDownstream = true;

        if (result.haltBranch) {
          namedNodeLogger.info(
            "Skipping downstream nodes because step requested halt"
          );
          shouldContinueDownstream = false;
        }

        // Check if this is a condition node. A disabled condition node never
        // evaluated anything, so it fans out to every branch instead.
        const isConditionNode =
          node.data.enabled !== false &&
          node.data.type === "action" &&
          node.data.config?.actionType === "Condition";

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
            const outgoingEdges = edgesBySource.get(nodeId) || [];
            const nextNodes = getConditionNextNodeIds({
              edges: outgoingEdges,
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
            downstreamReadyNodes.add(nodeId);
            await Promise.all(
              nextNodes.map((nextNodeId) => executeNode(nextNodeId))
            );
          }
        } else if (shouldContinueDownstream) {
          // For non-condition nodes, execute all next nodes in parallel. The
          // entry node is the exception: a normal start leaves by the Started
          // outlet, and the Canceled outlet's branch is reached only by a run
          // a Cancel Event claimed.
          const outgoingEdges = edgesBySource.get(nodeId) || [];
          const nextNodes =
            node.data.type === "trigger"
              ? getLifecycleNextNodeIds({
                  edges: outgoingEdges,
                  outlet: LIFECYCLE_STARTED_HANDLE,
                })
              : outgoingEdges.map((edge) => edge.target);
          namedNodeLogger.debug("Executing downstream nodes in parallel", {
            nextNodeCount: nextNodes.length,
            nextNodeIds: nextNodes,
          });
          // Execute all next nodes in parallel
          downstreamReadyNodes.add(nodeId);
          await Promise.all(
            nextNodes.map((nextNodeId) => executeNode(nextNodeId))
          );
        }
      }
    } catch (error) {
      // Every error escaping a node is that node's failure, and the run carries
      // on with its siblings. A cancellation never arrives this way: Rova's own
      // is the flag `settleCancelBoundary` reads, and Inngest stops calling a
      // cancelled function rather than throwing into it.
      namedNodeLogger.error("Unexpected error executing node", {
        error,
      });
      const errorMessage = await getErrorMessageAsync(error);
      const errorResult = {
        success: false,
        error: errorMessage,
      };
      results[nodeId] = errorResult;
      completedNodes.add(nodeId);
      // The node's own row was already closed with this error on its way out of
      // `runWithStepLog`, so what is left here is recording the failure for the
      // traversal.
    }
  }

  // Execute from each trigger node in parallel
  try {
    executionLogger.info("Starting execution from trigger nodes");
    await Promise.all(triggerNodes.map((trigger) => executeNode(trigger.id)));

    const finalSuccess = Object.values(results).every((r) => r.success);
    const duration = Date.now() - workflowStartTime;
    const finalOutput = getDeterministicTerminalOutput();
    // A cancel outranks what the nodes did: the run reached the end of the
    // Canceled branch, and that is the whole of what it means to be canceled.
    const terminalStatus: TraversalTerminalStatus = enteredCanceledBranch
      ? "canceled"
      : finalSuccess
        ? "completed"
        : "failed";

    executionLogger.info("Workflow execution completed", {
      success: finalSuccess,
      status: terminalStatus,
      resultCount: Object.keys(results).length,
      durationMs: duration,
    });

    // Wrapped as a durable step so the terminal record and its audit event are
    // written exactly once, even though the body replays after every wait.
    await runtime.step("workflow-run-completed", () =>
      recordRunCompleted({
        store,
        executionId,
        workflowId,
        status: terminalStatus,
        output: finalOutput,
        error: Object.values(results).find((r) => !r.success)?.error,
        startTime: workflowStartTime,
        duration,
        resultCount: Object.keys(results).length,
        runMode,
        logger: executionLogger,
      })
    );

    return {
      success: finalSuccess,
      results,
      outputs,
    };
  } catch (error) {
    executionLogger.error("Fatal error during workflow execution", {
      error,
    });

    const errorMessage = await getErrorMessageAsync(error);
    // The flag is the authority here as it is on the success path: a run is
    // canceled because a Cancel Event claimed it, never because the text of
    // whatever died happens to contain the word.
    const cancelled = enteredCanceledBranch;
    const terminalStatus = cancelled ? "canceled" : "failed";

    // Same exactly-once treatment as the success path above.
    await runtime.step("workflow-run-failed", () =>
      recordRunFailed({
        store,
        executionId,
        workflowId,
        status: terminalStatus,
        cancelled,
        error: errorMessage,
        startTime: workflowStartTime,
        runMode,
        logger: executionLogger,
      })
    );

    return {
      success: false,
      results,
      outputs,
      error: errorMessage,
      cancelled,
    };
  }
}
