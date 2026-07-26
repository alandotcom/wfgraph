/**
 * Workflow executor used by Inngest runtime.
 * Keeps node execution, templating, and logging behavior aligned with the builder.
 */

import { evaluateCelBooleanExpression } from "@/backend/lib/cel/environment";
import { getAppLogger } from "@/backend/lib/logger";
import {
  getActionLabel,
  getStepImporter,
  type StepImporter,
} from "@/backend/lib/step-registry";
import {
  type StepContext,
  withStepLogging,
} from "@/backend/lib/steps/step-handler";
import { triggerStep } from "@/backend/lib/steps/trigger";
import { withSpan } from "@/backend/lib/telemetry";
import { getErrorMessageAsync } from "@/shared/utils";
import { resolveWaitUntil } from "@/shared/utils/wait-time";
import { normalizeConditionBranch } from "@/shared/workflow/condition-branch";
import { toWorkflowGraphData } from "@/shared/workflow/graph";
import { validateWorkflowOutputAgainstSchema } from "@/shared/workflow/schema-validation";
import {
  evaluateWorkflowTrigger,
  resolveWorkflowTriggerDefinition,
} from "@/shared/workflow/trigger-registry";
import { resolveWebhookTriggerRuntimeConfig } from "@/shared/workflow/triggers/webhook-trigger";
import type {
  ConditionBranch,
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from "@/shared/workflow/types";
import {
  createInMemoryWorkflowRuntime,
  type WorkflowExecutionRuntime,
} from "./runtime";
import { noopWorkflowStore, type WorkflowStore } from "./store";

export type { WorkflowExecutionRuntime } from "./runtime";
export type { WorkflowStore } from "./store";

/**
 * Action type of the built-in Wait step. The executor dispatches on this value
 * to reach `executeWaitAction`, and the same check keeps Wait nodes out of the
 * node-level step wrapper (Wait suspends the run, and Inngest forbids a sleep
 * or a wait inside a step).
 */
const WAIT_ACTION_TYPE = "Wait";

// System actions that don't have plugins - maps to module import functions
const SYSTEM_ACTIONS: Record<string, StepImporter> = {
  "Database Query": {
    importer: () => import("@/backend/lib/steps/database-query"),
    stepFunction: "databaseQueryStep",
  },
  "HTTP Request": {
    importer: () => import("@/backend/lib/steps/http-request"),
    stepFunction: "httpRequestStep",
  },
  Condition: {
    importer: () => import("@/backend/lib/steps/condition"),
    stepFunction: "conditionStep",
  },
};

type ExecutionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  haltBranch?: boolean;
};

type NodeOutputs = Record<string, { label: string; data: unknown }>;

/**
 * What a node's memoized work reports back to the traversal. It travels through
 * the durable runtime (and therefore through JSON), so it carries only the
 * routing facts the scheduler needs, never live objects or callbacks.
 */
type NodeWorkOutcome = {
  result: ExecutionResult;
  /** Disabled nodes fan out to every branch instead of routing on a condition. */
  skippedDisabled?: boolean;
  /** Action node without an actionType: recorded as failed, no output stored. */
  unconfigured?: boolean;
};

export type WorkflowExecutionInput = {
  graph: SerializedWorkflowGraph;
  triggerInput?: Record<string, unknown>;
  requestPayload?: Record<string, unknown>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

function hasSuccessFlag(
  value: unknown
): value is { success: boolean; error?: unknown } {
  return isRecord(value) && typeof value.success === "boolean";
}

function readStepErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }
}

function hasHaltBranch(value: unknown): boolean {
  return isRecord(value) && value.haltBranch === true;
}

function isTriggeredFalse(value: unknown): boolean {
  return isRecord(value) && value.triggered === false;
}

function readConditionValue(value: unknown): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.condition === "boolean" ? value.condition : undefined;
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

function mergeConditionContextValue(
  context: Record<string, unknown>,
  value: unknown
) {
  if (!isRecord(value)) {
    return;
  }

  const record = value;
  Object.assign(context, record);

  const nestedInput = record.input;
  if (!isRecord(nestedInput)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(nestedInput)) {
    if (!(key in context)) {
      context[key] = nestedValue;
    }
  }
}

/**
 * Evaluate CEL condition expression against workflow output context.
 */
function evaluateConditionExpression(
  conditionExpression: unknown,
  outputs: NodeOutputs
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

  const evalContext: Record<string, unknown> = { now: new Date() };
  for (const output of Object.values(outputs)) {
    mergeConditionContextValue(evalContext, output.data);
  }

  const evaluation = evaluateCelBooleanExpression({
    expression,
    context: evalContext,
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
 * Execute a single action step with logging via stepHandler
 * IMPORTANT: Steps receive only the integration ID as a reference to fetch credentials.
 * This prevents credentials from being logged in Vercel's workflow observability.
 */
function executeActionStep(input: {
  actionType: string;
  config: Record<string, unknown>;
  outputs: NodeOutputs;
  context: StepContext;
}) {
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
}) {
  const { actionType, config, outputs, context } = input;
  const integrationId = readConfigString(config, "integrationId");

  // Build step input WITHOUT credentials, but WITH integrationId reference and logging context
  const stepInput: Record<string, unknown> = {
    ...config,
    _context: context,
  };

  // Special handling for Condition action - needs template evaluation
  if (actionType === "Condition") {
    const systemAction = SYSTEM_ACTIONS.Condition;
    const module = await systemAction.importer();
    const stepFn = module[systemAction.stepFunction];
    if (typeof stepFn !== "function") {
      return {
        success: false,
        error: `Step function "${systemAction.stepFunction}" not found for action "${actionType}".`,
      };
    }
    const originalExpression = stepInput.condition;
    const { result: evaluatedCondition } = evaluateConditionExpression(
      originalExpression,
      outputs
    );
    conditionLogger.debug("Condition evaluation result", {
      evaluatedCondition,
    });

    return await stepFn({
      condition: evaluatedCondition,
      // Include original expression for step logs.
      expression:
        typeof originalExpression === "string" ? originalExpression : undefined,
      _context: context,
    });
  }

  // Check system actions first (Database Query, HTTP Request)
  const systemAction = SYSTEM_ACTIONS[actionType];
  if (systemAction) {
    const module = await systemAction.importer();
    const stepFunction = module[systemAction.stepFunction];
    if (typeof stepFunction !== "function") {
      return {
        success: false,
        error: `Step function "${systemAction.stepFunction}" not found for action "${actionType}".`,
      };
    }
    return await stepFunction(stepInput);
  }

  // Look up plugin action from the generated step registry
  const stepImporter = getStepImporter(actionType);
  if (stepImporter) {
    if (typeof stepImporter.execute === "function") {
      const {
        actionType: _ignoredActionType,
        integrationId: _ignoredIntegrationId,
        ...runtimeActionPayload
      } = config;

      const executeFn = stepImporter.execute;
      return await withStepLogging({ _context: context }, async () =>
        executeFn({
          payload: runtimeActionPayload,
          context: {
            ...context,
            integrationId,
          },
        })
      );
    }

    const module = await stepImporter.importer();
    const stepFunction = module[stepImporter.stepFunction];
    if (typeof stepFunction === "function") {
      return await stepFunction(stepInput);
    }

    return {
      success: false,
      error: `Step function "${stepImporter.stepFunction}" not found in module for action "${actionType}". Check that the plugin exports the correct function name.`,
    };
  }

  // Fallback for unknown action types
  return {
    success: false,
    error: `Unknown action type: "${actionType}". This action is not registered in the plugin system. Available system actions: ${Object.keys(SYSTEM_ACTIONS).join(", ")}.`,
  };
}

/**
 * Process template variables in config
 */
function processTemplates(
  config: Record<string, unknown>,
  outputs: NodeOutputs
): Record<string, unknown> {
  const processed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      // Process template variables like {{@nodeId:Label.field}}
      let processedValue = value;
      const templatePattern = /\{\{@([^:]+):([^}]+)\}\}/g;
      processedValue = processedValue.replace(
        templatePattern,
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Template processing requires nested logic
        (match, nodeId, rest) => {
          const sanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
          const output = outputs[sanitizedNodeId];
          if (!output) {
            return match;
          }

          const dotIndex = rest.indexOf(".");
          if (dotIndex === -1) {
            // No field path, return the entire output data
            const data = output.data;
            if (data === null || data === undefined) {
              // Return empty string for null/undefined data (e.g., from disabled nodes)
              return "";
            }
            if (typeof data === "object") {
              return JSON.stringify(data);
            }
            if (typeof data === "string") {
              return data;
            }
            if (
              typeof data === "number" ||
              typeof data === "boolean" ||
              typeof data === "bigint"
            ) {
              return `${data}`;
            }
            if (typeof data === "symbol") {
              return data.toString();
            }
            return "";
          }

          // If data is null/undefined, return empty string instead of trying to access fields
          if (output.data === null || output.data === undefined) {
            return "";
          }

          const fieldPath = rest.substring(dotIndex + 1);
          const fields = fieldPath.split(".");
          let current: unknown = output.data;

          // For standardized outputs { success, data, error }, automatically look inside data
          // unless explicitly accessing success/data/error
          const firstField = fields[0];
          if (
            isRecord(current) &&
            "success" in current &&
            "data" in current &&
            firstField !== "success" &&
            firstField !== "data" &&
            firstField !== "error"
          ) {
            current = current.data;
          }

          for (const field of fields) {
            if (isRecord(current) && field in current) {
              current = current[field];
            } else {
              // Field access failed, return empty string
              return "";
            }
          }

          // Convert value to string, using JSON.stringify for objects/arrays
          if (current === null || current === undefined) {
            return "";
          }
          if (typeof current === "object") {
            return JSON.stringify(current);
          }
          if (typeof current === "string") {
            return current;
          }
          if (typeof current === "number" || typeof current === "boolean") {
            return String(current);
          }
          return "";
        }
      );

      processed[key] = processedValue;
    } else {
      processed[key] = value;
    }
  }

  return processed;
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

function escapeCelString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
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
  eventContext?: {
    eventType?: string;
    correlationKey?: string;
  };
};

/**
 * Wait context shared by the delay and hook branches.
 */
type WaitBranchContext = {
  config: Record<string, unknown>;
  context: StepContext;
  runtime: WorkflowExecutionRuntime;
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  runId: string;
  waitMode: "delay" | "hook" | "event";
  correlationKey?: string;
  /** Memoized "step started" log row reused by every branch below. */
  startLog: { logId: string; startTime: number };
};

function readWaitTimezone(config: Record<string, unknown>): string | undefined {
  return typeof config.waitTimezone === "string"
    ? config.waitTimezone
    : undefined;
}

function readWaitGateMode(
  config: Record<string, unknown>
): "require_actual_wait" | "off" {
  return config.waitGateMode === "require_actual_wait"
    ? "require_actual_wait"
    : "off";
}

function readAllowedHoursConfig(config: Record<string, unknown>) {
  return {
    waitAllowedHoursMode: config.waitAllowedHoursMode,
    waitAllowedStartTime: config.waitAllowedStartTime,
    waitAllowedEndTime: config.waitAllowedEndTime,
  };
}

function executeWaitAction(input: WaitActionInput): Promise<ExecutionResult> {
  const waitModeRawOuter =
    typeof input.config.waitMode === "string"
      ? input.config.waitMode.trim()
      : "";
  const waitTypeOuter =
    waitModeRawOuter === "hook" || waitModeRawOuter === "event"
      ? "hook"
      : "delay";

  return withSpan(
    "rova.workflow.wait",
    {
      "rova.wait.type": waitTypeOuter,
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
    config,
    context,
    runtime,
    store,
    executionId,
    workflowId,
    workflowRunId,
    eventContext,
  } = input;

  const waitModeRaw =
    typeof config.waitMode === "string" ? config.waitMode.trim() : "";
  const waitMode: "delay" | "hook" | "event" =
    waitModeRaw === "hook" || waitModeRaw === "event" ? waitModeRaw : "delay";

  const runId = workflowRunId || runtime.runId || executionId;

  if (waitMode === "event" && !eventContext?.correlationKey) {
    const errorMessage =
      "Wait mode 'event' requires a correlation key from the trigger. Ensure the workflow trigger has a correlation path configured.";

    // Both log rows are one durable unit so a replay does not duplicate them.
    await runtime.step(
      `wait-missing-correlation-${context.nodeId}`,
      async () => {
        const earlyLog = await store.startStepLog({
          executionId,
          nodeId: context.nodeId,
          nodeName: context.nodeName,
          nodeType: "Wait",
          input: { waitMode },
        });
        await store.completeStepLog({
          logId: earlyLog.logId,
          startTime: earlyLog.startTime,
          status: "error",
          error: errorMessage,
        });
        return { logged: true };
      }
    );

    return {
      success: false,
      error: errorMessage,
    };
  }

  // The "step started" row is written once and its id is replayed from the
  // memoized step return, so the branches below always close the same row.
  const startLog = await runtime.step(`wait-start-log-${context.nodeId}`, () =>
    store.startStepLog({
      executionId,
      nodeId: context.nodeId,
      nodeName: context.nodeName,
      nodeType: "Wait",
      input: {
        waitMode,
        waitDuration: config.waitDuration,
        waitUntil: config.waitUntil,
        waitOffset: config.waitOffset,
        waitTimezone: readWaitTimezone(config),
        waitGateMode: readWaitGateMode(config),
        ...readAllowedHoursConfig(config),
        waitForEvents: config.waitForEvents,
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
    waitMode,
    correlationKey: eventContext?.correlationKey,
    startLog,
  };

  if (waitMode === "delay") {
    return await executeDelayWait(branch);
  }
  return await executeHookWait(branch);
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
  const {
    config,
    context,
    store,
    executionId,
    workflowId,
    runId,
    waitMode,
    correlationKey,
    startLog,
  } = branch;

  const waitTimezone = readWaitTimezone(config);
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

  const waitUntilIso = resolved.waitUntil.toISOString();
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
      resumedAt: new Date().toISOString(),
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
        correlationKey,
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
    correlationKey,
    metadata: {
      waitMode,
      waitGateMode,
      waitTimezone,
    },
  });

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
      correlationKey,
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
        resumedAt: new Date().toISOString(),
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
 * Outcome of the persistence work that happens before a hook wait suspends the
 * run. The generated hook token lives here because it must survive replays.
 */
type HookWaitPreparation =
  | { status: "error"; error: string }
  | {
      status: "ready";
      waitStateId: string;
      hookToken: string;
      timeoutMs?: number;
    };

async function prepareHookWait(
  branch: WaitBranchContext
): Promise<HookWaitPreparation> {
  const {
    config,
    context,
    store,
    executionId,
    workflowId,
    runId,
    waitMode,
    correlationKey,
    startLog,
  } = branch;

  const waitTimeoutResolution =
    config.waitTimeout !== undefined && config.waitTimeout !== ""
      ? resolveWaitUntil({ waitDuration: config.waitTimeout })
      : { waitUntil: undefined, error: undefined };

  if (waitTimeoutResolution.error) {
    await store.completeStepLog({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "error",
      error: waitTimeoutResolution.error,
    });
    return { status: "error", error: waitTimeoutResolution.error };
  }

  const explicitHookToken =
    typeof config.waitHookToken === "string" && config.waitHookToken.trim()
      ? config.waitHookToken.trim()
      : undefined;
  const hookToken = explicitHookToken || generateWaitToken();

  const waitForEvents =
    typeof config.waitForEvents === "string" ? config.waitForEvents : undefined;

  const waitState = await store.createWaitState({
    executionId,
    workflowId,
    runId,
    nodeId: context.nodeId,
    nodeName: context.nodeName,
    waitType: "hook",
    hookToken,
    waitUntilIso: waitTimeoutResolution.waitUntil?.toISOString(),
    correlationKey,
    metadata: {
      waitForEvents,
      waitMode,
      waitTimeout: config.waitTimeout,
    },
  });

  const waitModeLabel = waitMode === "event" ? "event" : "hook";

  await store.recordAuditEvent({
    workflowId,
    executionId,
    eventType: "run_waiting",
    message: `Run waiting on ${waitModeLabel} in node '${context.nodeName}'`,
    metadata: {
      nodeId: context.nodeId,
      hookToken,
      waitForEvents,
      timeoutAt: waitTimeoutResolution.waitUntil?.toISOString(),
    },
  });

  return {
    status: "ready",
    waitStateId: waitState.waitStateId,
    hookToken,
    timeoutMs: waitTimeoutResolution.waitUntil
      ? Math.max(waitTimeoutResolution.waitUntil.getTime() - Date.now(), 0)
      : undefined,
  };
}

async function executeHookWait(
  branch: WaitBranchContext
): Promise<ExecutionResult> {
  const {
    config,
    context,
    runtime,
    store,
    executionId,
    workflowId,
    waitMode,
    startLog,
  } = branch;
  const waitType = "hook";
  const waitModeLabel = waitMode === "event" ? "event" : "hook";

  const prepared = await runtime.step(
    `wait-hook-prepare-${context.nodeId}`,
    () => prepareHookWait(branch)
  );

  if (prepared.status === "error") {
    return { success: false, error: prepared.error };
  }

  let timedOut = false;
  let hookPayload: unknown;

  try {
    const resumeEvent = await runtime.waitForEvent(
      `wait-hook-${context.nodeId}`,
      {
        event: "workflow/wait.signal",
        timeoutMs: prepared.timeoutMs,
        ifExpression: [
          "async.data.executionId == event.data.executionId",
          `async.data.nodeId == '${escapeCelString(context.nodeId)}'`,
          `async.data.token == '${escapeCelString(prepared.hookToken)}'`,
          `async.data.signalType == 'wait-resume'`,
        ].join(" && "),
      }
    );
    timedOut = resumeEvent === null;
    hookPayload = resumeEvent;
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
    `wait-hook-resume-${context.nodeId}`,
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
          ? `Run timed out in ${waitModeLabel} wait node '${context.nodeName}'`
          : `Run resumed from ${waitModeLabel} in node '${context.nodeName}'`,
        metadata: {
          nodeId: context.nodeId,
          hookToken: prepared.hookToken,
          waitMode,
        },
      });

      // An event wait configured to skip on timeout stops its branch instead of
      // letting downstream nodes run without the awaited event.
      const skipOnTimeout =
        timedOut &&
        waitMode === "event" &&
        config.waitTimeoutBehavior === "skip";

      const base = {
        waitType,
        waitMode,
        hookToken: prepared.hookToken,
        timedOut,
        resumedAt: new Date().toISOString(),
      };
      const output = skipOnTimeout
        ? { ...base, skipped: true, skippedReason: "timeout_skip" }
        : { ...base, ...(timedOut ? {} : { payload: hookPayload }) };

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
  status: "success" | "error";
  output: unknown;
  error?: string;
  startTime: number;
  duration: number;
  resultCount: number;
  runMode: "live" | "test";
  logger: ExecutionLogger;
}) {
  const succeeded = input.status === "success";

  try {
    await input.store.completeRun({
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
  status: "error" | "cancelled";
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
        // Look up the human-readable label from the step registry
        const label = getActionLabel(actionType);
        if (label) {
          return label;
        }
      }
      return "Action";
    }
    if (node.data.type === "trigger") {
      const triggerDefinition = resolveWorkflowTriggerDefinition(
        node.data.config
      );
      return triggerDefinition.ui.label;
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
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Node execution branches over trigger, action, and unknown node shapes.
  async function runNodeWork(
    node: WorkflowNode,
    nodeName: string,
    namedNodeLogger: ReturnType<typeof executionLogger.with>
  ): Promise<NodeWorkOutcome> {
    // Disabled nodes emit a null output so downstream templates don't hard-fail.
    if (node.data.enabled === false) {
      namedNodeLogger.info("Skipping disabled node");
      return {
        result: { success: true, data: null },
        skippedDisabled: true,
      };
    }

    let result: ExecutionResult = {
      success: false,
      error: "Node execution did not produce a result.",
    };

    if (node.data.type === "trigger") {
      namedNodeLogger.debug("Executing trigger node");

      const configRecord = node.data.config ?? {};
      const triggerDefinition = resolveWorkflowTriggerDefinition(configRecord);
      const webhookRuntimeConfig =
        triggerDefinition.runtime.executionType === "webhook"
          ? resolveWebhookTriggerRuntimeConfig(configRecord)
          : undefined;
      let triggerData: Record<string, unknown> = {
        triggered: true,
        timestamp: Date.now(),
      };

      const mockInput = webhookRuntimeConfig?.mockInput;
      if (
        mockInput &&
        (!triggerInput || Object.keys(triggerInput).length === 0)
      ) {
        triggerData = { ...triggerData, ...mockInput };
        namedNodeLogger.debug("Using trigger mock request payload", {
          mockData: mockInput,
        });
      } else if (triggerInput && Object.keys(triggerInput).length > 0) {
        // Use provided trigger input
        triggerData = { ...triggerData, ...triggerInput };
      }

      const triggerEvaluation = evaluateWorkflowTrigger({
        config: configRecord,
        payload: triggerData,
      });

      let ignoreReason: string | undefined;
      if (triggerEvaluation.routingDecision.kind === "stop") {
        ignoreReason = "stop_event";
      } else if (triggerEvaluation.routingDecision.kind === "ignore") {
        ignoreReason = triggerEvaluation.routingDecision.reason;
      }

      if (ignoreReason) {
        triggerData = {
          ...triggerData,
          triggered: false,
          eventType: triggerEvaluation.eventType,
          eventTypePath: webhookRuntimeConfig?.routing.eventTypePath,
          ignoredReason: ignoreReason,
        };

        namedNodeLogger.info("Trigger ignored by routing rules", {
          triggerType: triggerDefinition.runtime.type,
          eventType: triggerEvaluation.eventType,
          eventTypePath: webhookRuntimeConfig?.routing.eventTypePath,
          ignoredReason: ignoreReason,
        });
      }

      let shouldExecuteTriggerStep = true;

      if (!ignoreReason && triggerDefinition.runtime.type === "Webhook") {
        const schemaValidation = validateWorkflowOutputAgainstSchema({
          schemaValue: configRecord.webhookOutputSchema,
          output: triggerData,
          contextLabel: "Webhook trigger",
        });

        if (!schemaValidation.ok) {
          result = {
            success: false,
            error: schemaValidation.error,
          };
          shouldExecuteTriggerStep = false;
          namedNodeLogger.error("Webhook output schema validation failed", {
            error: schemaValidation.error,
          });
        }
      }

      if (shouldExecuteTriggerStep) {
        // Build context for logging
        const triggerContext: StepContext = {
          executionId,
          nodeId: node.id,
          nodeName,
          nodeType: node.data.type,
        };

        // Execute trigger step (handles logging internally)
        const triggerResult = await triggerStep({
          triggerData,
          _context: triggerContext,
        });

        result = {
          success: triggerResult.success,
          data: triggerResult.data,
        };
      }
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

      // Process templates in config, but keep conditions unprocessed for special handling
      const configWithoutCondition = { ...config };
      const originalCondition = config.condition;
      configWithoutCondition.condition = undefined;

      const processedConfig = processTemplates(configWithoutCondition, outputs);

      // Add back the original condition (unprocessed)
      if (originalCondition !== undefined) {
        processedConfig.condition = originalCondition;
      }

      // In test mode, keep test destination overrides as authored literals.
      // This prevents trigger/runtime payload templates from steering where
      // test-recipient messages are sent.
      if (runMode === "test") {
        if (actionType === "resend/send-email") {
          processedConfig.testEmailTo = config.testEmailTo;
        }

        if (actionType === "twilio/send-sms") {
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
      let stepResult: unknown;
      if (actionType === WAIT_ACTION_TYPE) {
        stepResult = await executeWaitAction({
          config: processedConfig,
          context: stepContext,
          runtime,
          store,
          executionId,
          workflowId,
          workflowRunId: currentWorkflowRunId,
          eventContext,
        });
      } else {
        stepResult = await executeActionStep({
          actionType,
          config: processedConfig,
          outputs,
          context: stepContext,
        });
      }

      actionLogger.debug("Step result received", {
        hasResult: !!stepResult,
        resultType: typeof stepResult,
      });

      // Check if the step returned an error result
      if (hasSuccessFlag(stepResult) && !stepResult.success) {
        // Support both old format (error: string) and new format (error: { message: string })
        const errorMessage =
          readStepErrorMessage(stepResult.error) ??
          `Step "${actionType}" in node "${node.data.label || node.id}" failed without a specific error message.`;
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
          haltBranch: hasHaltBranch(stepResult),
        };
      }
    } else {
      namedNodeLogger.error("Unknown node type");
      result = {
        success: false,
        error: `Unknown node type "${node.data.type}" in node "${node.data.label || node.id}". Expected "trigger" or "action".`,
      };
    }

    return { result };
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
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Downstream routing covers trigger gating, halted branches, and condition branches.
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

      // Store outputs with sanitized nodeId for template variable lookup
      const sanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
      outputs[sanitizedNodeId] = {
        label: node.data.label || nodeId,
        data: result.data,
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

        // Webhook trigger routing may intentionally ignore an event.
        if (
          node.data.type === "trigger" &&
          result.data &&
          isTriggeredFalse(result.data)
        ) {
          namedNodeLogger.info(
            "Skipping downstream nodes because trigger was not fired"
          );
          shouldContinueDownstream = false;
        }

        if (result.haltBranch && shouldContinueDownstream) {
          namedNodeLogger.info(
            "Skipping downstream nodes because step requested halt"
          );
          shouldContinueDownstream = false;
        }

        // Check if this is a condition node. A disabled condition node never
        // evaluated anything, so it fans out to every branch instead.
        const isConditionNode =
          outcome.skippedDisabled !== true &&
          node.data.type === "action" &&
          node.data.config?.actionType === "Condition";

        if (isConditionNode && shouldContinueDownstream) {
          const conditionResult = readConditionValue(result.data);
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
        status: finalSuccess ? "success" : "error",
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
    const terminalStatus = cancelled ? "cancelled" : "error";

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
