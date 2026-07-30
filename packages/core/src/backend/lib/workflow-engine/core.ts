/**
 * Workflow executor used by Inngest runtime.
 * Keeps node execution, templating, and logging behavior aligned with the builder.
 */

import { evaluateCompiledCondition } from "#src/backend/lib/cel/condition-payload";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  getActionLabel,
  getStepFunction,
  getSystemActionTypes,
} from "#src/backend/lib/step-registry";
import type { StepContext } from "#src/backend/lib/steps/step-handler";
import { triggerStep } from "#src/backend/lib/steps/trigger";
import { withSpan } from "#src/backend/lib/telemetry";
import { encodeIsoTimestamp } from "@rova/shared/types/timestamp";
import {
  type JsonObject,
  type JsonValue,
  readJsonValue,
} from "@rova/shared/types/json";
import { getErrorMessageAsync } from "@rova/shared/utils";
import { resolveWaitUntil } from "@rova/shared/utils/wait-time";
import { celStringLiteral } from "@rova/shared/workflow/cel-string-literal";
import { normalizeConditionBranch } from "@rova/shared/workflow/condition-branch";
import {
  collectTimestampFieldPaths,
  parseConditionModel,
} from "@rova/shared/workflow/conditions";
import { toWorkflowGraphData } from "@rova/shared/workflow/graph";
import {
  parseTemplate,
  resolveOutputPath,
  type TemplateToken,
  unwrapStepOutput,
} from "@rova/shared/workflow/node-references";
import type { StepResult } from "@rova/shared/workflow/step-result";
import {
  DEFAULT_WAIT_TIMEOUT,
  readWaitConfig,
  type WaitConfig,
} from "@rova/shared/workflow/wait-subscription";
import type {
  ConditionBranch,
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from "@rova/shared/workflow/types";
import {
  createInMemoryWorkflowRuntime,
  type WorkflowExecutionRuntime,
} from "./runtime";
import { noopWorkflowStore, type WorkflowStore } from "./store";
import { compileWaitSubscriptions, type ResolveTemplates } from "./wait-match";

export type { WorkflowExecutionRuntime } from "./runtime";
export type { WorkflowStore } from "./store";

/**
 * Action type of the built-in Wait step. The executor dispatches on this value
 * to reach `executeWaitAction`, and the same check keeps Wait nodes out of the
 * node-level step wrapper (Wait suspends the run, and Inngest forbids a sleep
 * or a wait inside a step).
 */
const WAIT_ACTION_TYPE = "Wait";

type ExecutionResult = {
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

/**
 * Execute a single action step with logging via stepHandler
 * IMPORTANT: Steps receive only the integration ID as a reference to fetch credentials.
 * This prevents credentials from being logged in Vercel's workflow observability.
 */
function executeActionStep(input: {
  actionType: string;
  config: Record<string, unknown>;
  outputs: NodeOutputs;
  context: StepContext;
}): Promise<ActionStepOutcome> {
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

async function executeActionStepInner(input: {
  actionType: string;
  config: Record<string, unknown>;
  outputs: NodeOutputs;
  context: StepContext;
}): Promise<ActionStepOutcome> {
  const { actionType, config, outputs, context } = input;

  // Build step input WITHOUT credentials, but WITH integrationId reference and logging context
  const stepInput: Record<string, unknown> = {
    ...config,
    _context: context,
  };

  // The Condition action evaluates its expression here, against the outputs of
  // the nodes upstream. The step it calls records the decision in the run log,
  // and the boolean travels back beside that record for the traversal to route
  // on.
  if (actionType === "Condition") {
    const { conditionStep } = await import("#src/backend/lib/steps/condition");
    const originalExpression = stepInput.condition;
    const { result: evaluatedCondition } = evaluateConditionExpression(
      originalExpression,
      outputs,
      config.conditionModel
    );
    conditionLogger.debug("Condition evaluation result", {
      evaluatedCondition,
    });

    return {
      result: await conditionStep({
        condition: evaluatedCondition,
        // Include original expression for step logs.
        expression:
          typeof originalExpression === "string"
            ? originalExpression
            : undefined,
        _context: context,
      }),
      conditionValue: evaluatedCondition,
    };
  }

  // Look up the action's implementation: an integration's step, a host's own
  // action, or one of the two the engine ships.
  const stepFunction = getStepFunction(actionType);
  if (stepFunction) {
    return { result: await stepFunction(stepInput) };
  }

  // Fallback for unknown action types
  return {
    result: {
      success: false,
      error: {
        message: `Unknown action type: "${actionType}". No action with this id was assembled: no integration, no host action, and none of the built-ins, which are ${getSystemActionTypes().join(", ")}.`,
      },
    },
  };
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
  // Outputs are keyed by a sanitized node id (see where they are stored below).
  const output = outputs[token.nodeId.replace(/[^a-zA-Z0-9]/g, "_")];
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function generateWaitToken(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isCancellationError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("cancelled") ||
    message.includes("canceled")
  );
}

type WaitActionInput = {
  config: Record<string, unknown>;
  context: StepContext;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  workflowRunId?: string;
  /** See `WaitBranchContext.resolveTemplates`. */
  resolveTemplates: ResolveTemplates;
};

/**
 * Wait context shared by the delay and event branches.
 */
type WaitBranchContext = {
  config: WaitConfig;
  context: StepContext;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  runId: string;
  /**
   * Resolves the `{{@nodeId:Label.field}}` references inside a match, which the
   * config-wide template pass does not reach: it walks the config's own string
   * values, and a match sits one level down inside `waitFor`.
   */
  resolveTemplates: ResolveTemplates;
  /** Memoized "step started" log row reused by every branch below. */
  startLog: { logId: string; startTime: number };
};

function readWaitGateMode(config: WaitConfig): "require_actual_wait" | "off" {
  return config.waitGateMode === "require_actual_wait"
    ? "require_actual_wait"
    : "off";
}

function readAllowedHoursConfig(config: WaitConfig) {
  return {
    waitAllowedHoursMode: config.waitAllowedHoursMode,
    waitAllowedStartTime: config.waitAllowedStartTime,
    waitAllowedEndTime: config.waitAllowedEndTime,
  };
}

function executeWaitAction(input: WaitActionInput): Promise<ExecutionResult> {
  const waitType = input.config.waitMode === "event" ? "event" : "delay";

  return withSpan(
    "rova.workflow.wait",
    {
      "rova.wait.type": waitType,
      "rova.node.id": input.context.nodeId,
      "rova.node.name": input.context.nodeName,
    },
    () => executeWaitActionInner(input)
  );
}

async function executeWaitActionInner(
  input: WaitActionInput
): Promise<ExecutionResult> {
  const {
    context,
    runtime,
    store,
    executionId,
    workflowId,
    workflowRunId,
    resolveTemplates,
  } = input;

  const runId = workflowRunId || runtime.runId || executionId;

  // The first schema this node has ever had, so a config written against the
  // retired shape stops the run here rather than parking on a wait nothing can
  // reach. Both log rows are one durable unit, so a replay does not duplicate.
  const read = readWaitConfig(input.config);
  if (!read.valid) {
    const errorMessage = `Wait node configuration is invalid: ${read.error}`;
    await runtime.step(`wait-invalid-config-${context.nodeId}`, async () => {
      const earlyLog = await store.startStepLog({
        executionId,
        nodeId: context.nodeId,
        nodeName: context.nodeName,
        nodeType: "Wait",
        input: {},
      });
      await store.completeStepLog({
        logId: earlyLog.logId,
        startTime: earlyLog.startTime,
        status: "error",
        error: errorMessage,
      });
      return { logged: true };
    });

    return { success: false, error: errorMessage };
  }

  const config = read.config;

  // The "step started" row is written once and its id is replayed from the
  // memoized step return, so the branches below always close the same row.
  const startLog = await runtime.step(`wait-start-log-${context.nodeId}`, () =>
    store.startStepLog({
      executionId,
      nodeId: context.nodeId,
      nodeName: context.nodeName,
      nodeType: "Wait",
      input: {
        waitMode: read.waitMode,
        waitDuration: config.waitDuration,
        waitUntil: config.waitUntil,
        waitOffset: config.waitOffset,
        waitTimezone: config.waitTimezone,
        waitGateMode: readWaitGateMode(config),
        ...readAllowedHoursConfig(config),
        waitFor: config.waitFor?.map((subscription) => subscription.event),
        waitTimeout: config.waitTimeout,
      },
    })
  );

  const branch: WaitBranchContext = {
    config,
    context,
    runtime,
    store,
    executionId,
    workflowId,
    runId,
    resolveTemplates,
    startLog,
  };

  if (read.waitMode === "delay") {
    return await executeDelayWait(branch);
  }
  return await executeEventWait(branch);
}

/**
 * Outcome of the persistence work that happens before a delay wait suspends
 * the run. Crosses a step boundary, so every field is JSON-safe.
 */
type DelayWaitPreparation =
  | { status: "error"; error: string }
  | { status: "skipped"; output: Record<string, unknown> }
  | {
      status: "ready";
      waitStateId: string;
      waitUntilIso: string;
      plannedWaitMs: number;
    };

async function prepareDelayWait(
  branch: WaitBranchContext
): Promise<DelayWaitPreparation> {
  const { config, context, store, executionId, workflowId, runId, startLog } =
    branch;

  const waitTimezone = config.waitTimezone;
  const waitGateMode = readWaitGateMode(config);

  const resolved = resolveWaitUntil({
    waitDuration: config.waitDuration,
    waitUntil: config.waitUntil,
    waitOffset: config.waitOffset,
    waitTimezone,
    ...readAllowedHoursConfig(config),
  });

  if (!resolved.waitUntil) {
    const errorMessage =
      resolved.error ||
      "Wait could not determine a target timestamp from waitUntil/waitDuration.";
    await store.completeStepLog({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "error",
      error: errorMessage,
    });
    return { status: "error", error: errorMessage };
  }

  const waitUntilIso = encodeIsoTimestamp(resolved.waitUntil);
  const plannedWaitMs = resolved.waitUntil.getTime() - Date.now();
  const didActuallyWait = plannedWaitMs > 0;

  // Gate mode treats an already-passed target as "nothing to wait for" and
  // stops the branch instead of falling through to a zero-length sleep.
  if (waitGateMode === "require_actual_wait" && !didActuallyWait) {
    const output = {
      waitType: "delay",
      waitUntil: waitUntilIso,
      waitGateMode,
      skipped: true,
      skippedReason: "past_due_no_wait",
      plannedWaitMs,
      didActuallyWait,
      resumedAt: encodeIsoTimestamp(new Date()),
    };

    await store.recordAuditEvent({
      workflowId,
      executionId,
      eventType: "run_skipped",
      message: `Skipped delay branch in node '${context.nodeName}' (target already passed)`,
      metadata: {
        nodeId: context.nodeId,
        waitType: "delay",
        waitUntil: waitUntilIso,
        plannedWaitMs,
        reason: "past_due_no_wait",
      },
    });

    await store.completeStepLog({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "success",
      output,
    });

    return { status: "skipped", output };
  }

  const waitState = await store.createWaitState({
    executionId,
    workflowId,
    runId,
    nodeId: context.nodeId,
    nodeName: context.nodeName,
    waitType: "delay",
    waitUntilIso,
    metadata: {
      waitGateMode,
      waitTimezone,
    },
  });

  if (!waitState) {
    // A policy cancel flipped the execution terminal between the last step
    // and this park; Inngest is already killing the run.
    const cancelledMessage =
      "Execution was cancelled before the wait was registered";
    await store.completeStepLog({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "error",
      error: cancelledMessage,
    });
    return { status: "error", error: cancelledMessage };
  }

  await store.recordAuditEvent({
    workflowId,
    executionId,
    eventType: "run_waiting",
    message: `Run waiting in delay node '${context.nodeName}'`,
    metadata: {
      nodeId: context.nodeId,
      waitType: "delay",
      waitUntil: waitUntilIso,
      waitGateMode,
    },
  });

  return {
    status: "ready",
    waitStateId: waitState.waitStateId,
    waitUntilIso,
    plannedWaitMs,
  };
}

async function executeDelayWait(
  branch: WaitBranchContext
): Promise<ExecutionResult> {
  const { context, runtime, store, executionId, workflowId, startLog } = branch;

  // Everything before the sleep is one durable step: a replay must not resolve
  // a fresh target time or insert a second wait-state row.
  const prepared = await runtime.step(
    `wait-delay-prepare-${context.nodeId}`,
    () => prepareDelayWait(branch)
  );

  if (prepared.status === "error") {
    return { success: false, error: prepared.error };
  }

  if (prepared.status === "skipped") {
    return { success: true, data: prepared.output, haltBranch: true };
  }

  try {
    await runtime.sleep(
      `wait-delay-${context.nodeId}`,
      Math.max(prepared.plannedWaitMs, 0)
    );
  } catch (error) {
    // Failure here means the run is unwinding (cancellation surfaces this way),
    // so the closing log row is written directly rather than as a new step.
    await store.completeStepLog({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "error",
      error: getErrorMessage(error),
    });
    throw error;
  }

  const output = await runtime.step(
    `wait-delay-resume-${context.nodeId}`,
    async () => {
      await store.markWaitStateStatus({
        waitStateId: prepared.waitStateId,
        status: "resumed",
      });
      await store.markExecutionRunning({ executionId });

      await store.recordAuditEvent({
        workflowId,
        executionId,
        eventType: "run_resumed",
        message: `Run resumed after delay in node '${context.nodeName}'`,
        metadata: {
          nodeId: context.nodeId,
        },
      });

      const resumeOutput = {
        waitType: "delay",
        waitUntil: prepared.waitUntilIso,
        resumedAt: encodeIsoTimestamp(new Date()),
      };

      await store.completeStepLog({
        logId: startLog.logId,
        startTime: startLog.startTime,
        status: "success",
        output: resumeOutput,
      });

      return resumeOutput;
    }
  );

  return { success: true, data: output };
}

/**
 * Outcome of the persistence work that happens before an event wait suspends the
 * run. Everything a resumed run needs is here rather than read from the config
 * again: this crosses a memoized step boundary, so it is what the run parked
 * with, and a graph edited while the run was parked cannot reach it.
 */
type EventWaitPreparation =
  | { status: "error"; error: string }
  | {
      status: "ready";
      waitStateId: string;
      resumeToken: string;
      timeoutMs?: number;
      timeoutBehavior: "continue" | "skip";
    };

async function prepareEventWait(
  branch: WaitBranchContext
): Promise<EventWaitPreparation> {
  const {
    config,
    context,
    store,
    executionId,
    workflowId,
    runId,
    resolveTemplates,
    startLog,
  } = branch;

  const failWith = async (error: string): Promise<EventWaitPreparation> => {
    await store.completeStepLog({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "error",
      error,
    });
    return { status: "error", error };
  };

  // The timeout is what keeps a parked run mortal, so a wait that names none is
  // held to the default the editor writes rather than parking forever.
  const timeout = config.waitTimeout?.trim() || DEFAULT_WAIT_TIMEOUT;
  const waitTimeoutResolution = resolveWaitUntil({ waitDuration: timeout });
  if (waitTimeoutResolution.error || !waitTimeoutResolution.waitUntil) {
    return await failWith(
      waitTimeoutResolution.error ??
        "Wait could not determine a timeout from waitTimeout."
    );
  }

  const compiled = compileWaitSubscriptions({
    subscriptions: config.waitFor ?? [],
    resolveTemplates,
  });
  if (!compiled.valid) {
    return await failWith(compiled.error);
  }

  const resumeToken = generateWaitToken();
  const waitUntilIso = encodeIsoTimestamp(waitTimeoutResolution.waitUntil);
  const timeoutBehavior = config.waitTimeoutBehavior ?? "continue";

  const waitState = await store.createWaitState({
    executionId,
    workflowId,
    runId,
    nodeId: context.nodeId,
    nodeName: context.nodeName,
    waitType: "event",
    resumeToken,
    waitUntilIso,
    subscribedEvents: compiled.subscriptions.map(
      (subscription) => subscription.event
    ),
    // Everything here crosses the JSONB column and Inngest's memoization, so a
    // compiled string and a literal are what the match is reduced to.
    metadata: {
      waitTimeout: timeout,
      waitTimeoutBehavior: timeoutBehavior,
      waitFor: compiled.subscriptions,
    },
  });

  if (!waitState) {
    // A policy cancel flipped the execution terminal between the last step
    // and this park; Inngest is already killing the run.
    return await failWith(
      "Execution was cancelled before the wait was registered"
    );
  }

  await store.recordAuditEvent({
    workflowId,
    executionId,
    eventType: "run_waiting",
    message: `Run waiting on event in node '${context.nodeName}'`,
    metadata: {
      nodeId: context.nodeId,
      resumeToken,
      waitFor: compiled.subscriptions.map((subscription) => subscription.event),
      timeoutAt: waitUntilIso,
    },
  });

  return {
    status: "ready",
    waitStateId: waitState.waitStateId,
    resumeToken,
    timeoutMs: Math.max(
      waitTimeoutResolution.waitUntil.getTime() - Date.now(),
      0
    ),
    timeoutBehavior,
  };
}

async function executeEventWait(
  branch: WaitBranchContext
): Promise<ExecutionResult> {
  const { context, runtime, store, executionId, workflowId, startLog } = branch;

  const prepared = await runtime.step(
    `wait-event-prepare-${context.nodeId}`,
    () => prepareEventWait(branch)
  );

  if (prepared.status === "error") {
    return { success: false, error: prepared.error };
  }

  let timedOut = false;
  let eventPayload: unknown;

  try {
    // Inngest waits on Rova's own signal envelope rather than on the business
    // Event: which runs an arrival concerns is decided by resume matching, in
    // Rova code, before this signal is ever sent.
    const resumeEvent = await runtime.waitForEvent(
      `wait-event-${context.nodeId}`,
      {
        event: "workflow/wait.signal",
        timeoutMs: prepared.timeoutMs,
        ifExpression: [
          "async.data.executionId == event.data.executionId",
          `async.data.nodeId == ${celStringLiteral(context.nodeId)}`,
          `async.data.token == ${celStringLiteral(prepared.resumeToken)}`,
          `async.data.signalType == ${celStringLiteral("wait-resume")}`,
        ].join(" && "),
      }
    );
    timedOut = resumeEvent === null;
    eventPayload = resumeEvent;
  } catch (error) {
    // Same reasoning as the delay branch: the run is unwinding, so no new step.
    await store.completeStepLog({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "error",
      error: getErrorMessage(error),
    });
    throw error;
  }

  const resumed = await runtime.step(
    `wait-event-resume-${context.nodeId}`,
    async () => {
      await store.markWaitStateStatus({
        waitStateId: prepared.waitStateId,
        status: timedOut ? "timed_out" : "resumed",
      });
      await store.markExecutionRunning({ executionId });

      await store.recordAuditEvent({
        workflowId,
        executionId,
        eventType: timedOut ? "run_timed_out" : "run_resumed",
        message: timedOut
          ? `Run timed out in event wait node '${context.nodeName}'`
          : `Run resumed from event in node '${context.nodeName}'`,
        metadata: {
          nodeId: context.nodeId,
          resumeToken: prepared.resumeToken,
        },
      });

      // A wait configured to skip on timeout stops its branch instead of letting
      // downstream nodes run without the awaited Event. The behaviour comes off
      // the preparation, which is what this run parked with: a wait can outlive
      // several edits to the node it parked on, and none of them may change how
      // this run treats a timeout it is already counting down.
      const skipOnTimeout = timedOut && prepared.timeoutBehavior === "skip";

      const base = {
        waitType: "event",
        resumeToken: prepared.resumeToken,
        timedOut,
        resumedAt: encodeIsoTimestamp(new Date()),
      };
      const output = skipOnTimeout
        ? { ...base, skipped: true, skippedReason: "timeout_skip" }
        : { ...base, ...(timedOut ? {} : { payload: eventPayload }) };

      await store.completeStepLog({
        logId: startLog.logId,
        startTime: startLog.startTime,
        status: "success",
        output,
      });

      return { output, skipOnTimeout };
    }
  );

  if (resumed.skipOnTimeout) {
    return { success: true, data: resumed.output, haltBranch: true };
  }

  return { success: true, data: resumed.output };
}

type ExecutionLogger = ReturnType<typeof workflowExecutorLogger.with>;

function buildRunCompletedMessage(
  runMode: "live" | "test",
  success: boolean
): string {
  if (runMode === "test") {
    return success
      ? "Test mode completed successfully"
      : "Test mode completed with errors";
  }
  return success ? "Run completed successfully" : "Run completed with errors";
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
 * Writes the terminal record and timeline event for a run that finished its
 * graph. Runs inside a durable step, so it must stay side-effect-idempotent
 * from the caller's point of view: nothing here feeds back into the traversal.
 */
async function recordRunCompleted(input: {
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  status: "completed" | "failed";
  output: unknown;
  error?: string;
  startTime: number;
  duration: number;
  resultCount: number;
  runMode: "live" | "test";
  logger: ExecutionLogger;
}) {
  const succeeded = input.status === "completed";
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
      eventType: succeeded ? "run_completed" : "run_failed",
      message: buildRunCompletedMessage(input.runMode, succeeded),
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
  try {
    await input.store.completeRun({
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

  return { status: input.status };
}

/**
 * Main workflow executor function.
 *
 * Both dependencies are ports the caller supplies: `runtime` decides how work
 * is made durable, `store` decides where the run's trace is written. The
 * defaults are the honest in-process choices - work runs inline, nothing is
 * persisted - so a caller that wants a run recorded must inject a store that
 * records. The Inngest adapter in lib/inngest/workflow-function.ts is where a
 * real run picks up `dbWorkflowStore`.
 */
export function executeWorkflow(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime = createInMemoryWorkflowRuntime(),
  store: WorkflowStore = noopWorkflowStore
) {
  return withSpan(
    "rova.workflow.execution",
    {
      "rova.workflow.id": input.workflowId,
      "rova.execution.id": input.executionId,
      "rova.workflow.name": input.workflowName,
      "rova.execution.run_mode": input.runMode ?? "live",
    },
    () => executeWorkflowInner(input, runtime, store)
  );
}

async function executeWorkflowInner(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore
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
        const label = getActionLabel(actionType);
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

      const triggerContext: StepContext = {
        executionId,
        nodeId: node.id,
        nodeName,
        nodeType: node.data.type,
      };

      // The step logs its own run rows, which is why the payload passes through
      // one rather than being written straight into the outputs.
      const triggerResult = await triggerStep({
        triggerData,
        _context: triggerContext,
      });

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

      // Build step context for logging (stepHandler will handle the logging)
      const stepContext: StepContext = {
        executionId,
        nodeId: node.id,
        nodeName: getNodeName(node),
        nodeType: actionType,
        runMode,
      };
      // Execute the action step with stepHandler (logging is handled inside)
      // IMPORTANT: We pass integrationId via config, not actual credentials
      // Steps fetch credentials internally using fetchCredentials(integrationId)
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
          executionId,
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
    const isWaitNode =
      node.data.type === "action" &&
      readConfigString(node.data.config, "actionType") === WAIT_ACTION_TYPE;

    if (isWaitNode || node.data.enabled === false) {
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
      const sanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
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
          // For non-condition nodes, execute all next nodes in parallel
          const nextNodes = (edgesBySource.get(nodeId) || []).map(
            (edge) => edge.target
          );
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
      namedNodeLogger.error("Unexpected error executing node", {
        error,
      });
      if (isCancellationError(error)) {
        throw error;
      }
      const errorMessage = await getErrorMessageAsync(error);
      const errorResult = {
        success: false,
        error: errorMessage,
      };
      results[nodeId] = errorResult;
      completedNodes.add(nodeId);
      // Note: stepHandler already logged the error for action steps
      // Trigger steps don't throw, so this catch is mainly for unexpected errors
    }
  }

  // Execute from each trigger node in parallel
  try {
    executionLogger.info("Starting execution from trigger nodes");
    await Promise.all(triggerNodes.map((trigger) => executeNode(trigger.id)));

    const finalSuccess = Object.values(results).every((r) => r.success);
    const duration = Date.now() - workflowStartTime;
    const finalOutput = getDeterministicTerminalOutput();

    executionLogger.info("Workflow execution completed", {
      success: finalSuccess,
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
        status: finalSuccess ? "completed" : "failed",
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
    const cancelled = isCancellationError(error);
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
