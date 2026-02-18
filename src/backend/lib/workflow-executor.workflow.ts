/**
 * Workflow executor used by Inngest runtime.
 * Keeps node execution, templating, and logging behavior aligned with the builder.
 */

import { evaluateCelBooleanExpression } from "@/backend/lib/cel/environment";
import { getAppLogger } from "@/backend/lib/logger";
import { getErrorMessageAsync } from "@/shared/utils";
import { resolveWaitUntil } from "@/shared/utils/wait-time";
import { normalizeConditionBranch } from "@/shared/workflow/condition-branch";
import { toWorkflowGraphData } from "@/shared/workflow/graph";
import {
  evaluateWorkflowTrigger,
  resolveWorkflowTriggerDefinition,
} from "@/shared/workflow/trigger-registry";
import type {
  ConditionBranch,
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from "@/shared/workflow/types";
import {
  getActionLabel,
  getStepImporter,
  type StepImporter,
} from "./step-registry";
import { workflowAuditStep } from "./steps/internal-workflow-audit";
import {
  stepLogCompleteStep,
  stepLogStartStep,
} from "./steps/internal-workflow-logging";
import {
  createWaitStateStep,
  markExecutionRunningStep,
  markWaitStateStatusStep,
} from "./steps/internal-workflow-wait-state";
import { logWorkflowComplete, type StepContext } from "./steps/step-handler";
import { triggerStep } from "./steps/trigger";

type WaitForEventOptions = {
  event: string;
  timeoutMs?: number;
  ifExpression?: string;
};

export type WorkflowExecutionRuntime = {
  sleep: (stepId: string, durationMs: number) => Promise<void>;
  waitForEvent: (
    stepId: string,
    options: WaitForEventOptions
  ) => Promise<unknown>;
  runId?: string;
};

const DEFAULT_RUNTIME: WorkflowExecutionRuntime = {
  sleep: async (_stepId, durationMs) => {
    if (durationMs <= 0) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, durationMs);
    });
  },
  waitForEvent: async () => null,
};

// System actions that don't have plugins - maps to module import functions
const SYSTEM_ACTIONS: Record<string, StepImporter> = {
  "Database Query": {
    importer: () => import("./steps/database-query"),
    stepFunction: "databaseQueryStep",
  },
  "HTTP Request": {
    importer: () => import("./steps/http-request"),
    stepFunction: "httpRequestStep",
  },
  Condition: {
    importer: () => import("./steps/condition"),
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

export type WorkflowExecutionInput = {
  graph: SerializedWorkflowGraph;
  triggerInput?: Record<string, unknown>;
  requestPayload?: Record<string, unknown>;
  executionId?: string;
  workflowId?: string; // Used by steps to fetch credentials
  workflowName?: string;
  workflowRunId?: string;
  dryRun?: boolean;
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
async function executeActionStep(input: {
  actionType: string;
  config: Record<string, unknown>;
  outputs: NodeOutputs;
  context: StepContext;
}) {
  const { actionType, config, outputs, context } = input;

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
      return await stepImporter.execute(stepInput);
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
          // biome-ignore lint/suspicious/noExplicitAny: Dynamic output data traversal
          let current: any = output.data;

          // For standardized outputs { success, data, error }, automatically look inside data
          // unless explicitly accessing success/data/error
          const firstField = fields[0];
          if (
            current &&
            typeof current === "object" &&
            "success" in current &&
            "data" in current &&
            firstField !== "success" &&
            firstField !== "data" &&
            firstField !== "error"
          ) {
            current = current.data;
          }

          for (const field of fields) {
            if (current && typeof current === "object") {
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
          return String(current);
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

async function executeDryRunAction(input: {
  actionType: string;
  context: StepContext;
  executionId?: string;
}): Promise<ExecutionResult> {
  const output = {
    dryRun: true,
    simulated: true,
    actionType: input.actionType,
    message: `Dry run skipped side effects for '${input.actionType}'`,
    timestamp: new Date().toISOString(),
  };

  if (!input.executionId) {
    return { success: true, data: output };
  }

  const startLog = await stepLogStartStep({
    executionId: input.executionId,
    nodeId: input.context.nodeId,
    nodeName: input.context.nodeName,
    nodeType: input.actionType,
    input: {
      dryRun: true,
      actionType: input.actionType,
    },
  });

  await stepLogCompleteStep({
    logId: startLog.logId,
    startTime: startLog.startTime,
    status: "success",
    output,
  });

  return { success: true, data: output };
}

async function executeSkippedAction(input: {
  actionType: string;
  context: StepContext;
  reason: string;
  executionId?: string;
  workflowId?: string;
  eventContext?: {
    eventType?: string;
    correlationKey?: string;
  };
  runCondition?: unknown;
}): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = {
    skipped: true,
    skippedReason: input.reason,
    actionType: input.actionType,
    timestamp: new Date().toISOString(),
  };

  if (input.runCondition !== undefined) {
    output.runCondition = input.runCondition;
  }

  if (input.executionId) {
    const startLog = await stepLogStartStep({
      executionId: input.executionId,
      nodeId: input.context.nodeId,
      nodeName: input.context.nodeName,
      nodeType: input.actionType,
      input: {
        skipped: true,
        skippedReason: input.reason,
        runCondition: input.runCondition,
      },
    });

    await stepLogCompleteStep({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "success",
      output,
    });
  }

  if (input.workflowId) {
    await workflowAuditStep({
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: "run_skipped",
      message: `Skipped node '${input.context.nodeName}' because run condition evaluated false`,
      metadata: {
        nodeId: input.context.nodeId,
        actionType: input.actionType,
        reason: input.reason,
        correlationKey: input.eventContext?.correlationKey,
      },
    });
  }

  return output;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Wait execution has intentional branching for delay/hook/dry-run and cancellation.
async function executeWaitAction(input: {
  config: Record<string, unknown>;
  context: StepContext;
  runtime: WorkflowExecutionRuntime;
  executionId?: string;
  workflowId?: string;
  workflowRunId?: string;
  dryRun?: boolean;
  eventContext?: {
    eventType?: string;
    correlationKey?: string;
  };
}): Promise<ExecutionResult> {
  const {
    config,
    context,
    runtime,
    executionId,
    workflowId,
    workflowRunId,
    dryRun,
    eventContext,
  } = input;

  if (!(executionId && workflowId)) {
    return {
      success: false,
      error: "Wait requires execution context (executionId, workflowId).",
    };
  }

  const waitModeRaw = config.waitMode;
  const waitMode =
    typeof waitModeRaw === "string" && waitModeRaw.trim()
      ? waitModeRaw.trim()
      : "delay";

  const waitType = waitMode === "hook" ? "hook" : "delay";
  const runId = workflowRunId || runtime.runId || executionId;
  const waitTimezone =
    typeof config.waitTimezone === "string" ? config.waitTimezone : undefined;
  const waitGateMode =
    config.waitGateMode === "require_actual_wait"
      ? "require_actual_wait"
      : "off";

  const startLog = await stepLogStartStep({
    executionId,
    nodeId: context.nodeId,
    nodeName: context.nodeName,
    nodeType: "Wait",
    input: {
      waitMode,
      waitDuration: config.waitDuration,
      waitUntil: config.waitUntil,
      waitOffset: config.waitOffset,
      waitTimezone,
      waitGateMode,
      waitForEvents: config.waitForEvents,
      waitTimeout: config.waitTimeout,
    },
  });

  if (dryRun) {
    const resolvedDelay =
      waitType === "delay"
        ? resolveWaitUntil({
            waitDuration: config.waitDuration,
            waitUntil: config.waitUntil,
            waitOffset: config.waitOffset,
            waitTimezone,
          })
        : { waitUntil: undefined, error: undefined };

    if (resolvedDelay.error) {
      await stepLogCompleteStep({
        logId: startLog.logId,
        startTime: startLog.startTime,
        status: "error",
        error: resolvedDelay.error,
      });

      return {
        success: false,
        error: resolvedDelay.error,
      };
    }

    if (waitType === "delay" && resolvedDelay.waitUntil) {
      const plannedWaitMs = resolvedDelay.waitUntil.getTime() - Date.now();
      const didActuallyWait = plannedWaitMs > 0;

      if (waitGateMode === "require_actual_wait" && !didActuallyWait) {
        const output = {
          dryRun: true,
          simulated: true,
          waitType,
          waitUntil: resolvedDelay.waitUntil.toISOString(),
          waitGateMode,
          skipped: true,
          skippedReason: "past_due_no_wait",
          plannedWaitMs,
          didActuallyWait,
          resumedAt: new Date().toISOString(),
          message:
            "Dry run would skip this branch because no actual wait time remained.",
        };

        await stepLogCompleteStep({
          logId: startLog.logId,
          startTime: startLog.startTime,
          status: "success",
          output,
        });

        return {
          success: true,
          data: output,
          haltBranch: true,
        };
      }
    }

    const output = {
      dryRun: true,
      simulated: true,
      waitType,
      waitUntil: resolvedDelay.waitUntil?.toISOString(),
      waitGateMode,
      waitForEvents:
        typeof config.waitForEvents === "string" ? config.waitForEvents : null,
      resumedAt: new Date().toISOString(),
      message: "Dry run skipped waiting and resumed immediately",
    };

    await stepLogCompleteStep({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "success",
      output,
    });

    return {
      success: true,
      data: output,
    };
  }

  if (waitType === "delay") {
    const resolved = resolveWaitUntil({
      waitDuration: config.waitDuration,
      waitUntil: config.waitUntil,
      waitOffset: config.waitOffset,
      waitTimezone,
    });

    if (!resolved.waitUntil) {
      const errorMessage =
        resolved.error ||
        "Wait could not determine a target timestamp from waitUntil/waitDuration.";
      await stepLogCompleteStep({
        logId: startLog.logId,
        startTime: startLog.startTime,
        status: "error",
        error: errorMessage,
      });
      return {
        success: false,
        error: errorMessage,
      };
    }

    const plannedWaitMs = resolved.waitUntil.getTime() - Date.now();
    const didActuallyWait = plannedWaitMs > 0;

    if (waitGateMode === "require_actual_wait" && !didActuallyWait) {
      const output = {
        waitType: "delay",
        waitUntil: resolved.waitUntil.toISOString(),
        waitGateMode,
        skipped: true,
        skippedReason: "past_due_no_wait",
        plannedWaitMs,
        didActuallyWait,
        resumedAt: new Date().toISOString(),
      };

      await workflowAuditStep({
        workflowId,
        executionId,
        eventType: "run_skipped",
        message: `Skipped delay branch in node '${context.nodeName}' (target already passed)`,
        metadata: {
          nodeId: context.nodeId,
          waitType: "delay",
          waitUntil: resolved.waitUntil.toISOString(),
          plannedWaitMs,
          reason: "past_due_no_wait",
          correlationKey: eventContext?.correlationKey,
        },
      });

      await stepLogCompleteStep({
        logId: startLog.logId,
        startTime: startLog.startTime,
        status: "success",
        output,
      });

      return {
        success: true,
        data: output,
        haltBranch: true,
      };
    }

    const waitState = await createWaitStateStep({
      executionId,
      workflowId,
      runId,
      nodeId: context.nodeId,
      nodeName: context.nodeName,
      waitType: "delay",
      waitUntilIso: resolved.waitUntil.toISOString(),
      correlationKey: eventContext?.correlationKey,
      metadata: {
        waitMode,
        waitGateMode,
        waitTimezone,
      },
    });

    await workflowAuditStep({
      workflowId,
      executionId,
      eventType: "run_waiting",
      message: `Run waiting in delay node '${context.nodeName}'`,
      metadata: {
        nodeId: context.nodeId,
        waitType: "delay",
        waitUntil: resolved.waitUntil.toISOString(),
        waitGateMode,
        correlationKey: eventContext?.correlationKey,
      },
    });

    try {
      const waitMs = Math.max(plannedWaitMs, 0);
      await runtime.sleep(`wait-delay-${context.nodeId}`, waitMs);
    } catch (error) {
      await stepLogCompleteStep({
        logId: startLog.logId,
        startTime: startLog.startTime,
        status: "error",
        error: getErrorMessage(error),
      });
      throw error;
    }

    await markWaitStateStatusStep({
      waitStateId: waitState.id,
      status: "resumed",
    });
    await markExecutionRunningStep({ executionId });

    await workflowAuditStep({
      workflowId,
      executionId,
      eventType: "run_resumed",
      message: `Run resumed after delay in node '${context.nodeName}'`,
      metadata: {
        nodeId: context.nodeId,
      },
    });

    const output = {
      waitType: "delay",
      waitUntil: resolved.waitUntil.toISOString(),
      resumedAt: new Date().toISOString(),
    };

    await stepLogCompleteStep({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "success",
      output,
    });

    return {
      success: true,
      data: output,
    };
  }

  const waitTimeoutResolution =
    config.waitTimeout !== undefined && config.waitTimeout !== ""
      ? resolveWaitUntil({
          waitDuration: config.waitTimeout,
        })
      : { waitUntil: undefined, error: undefined };

  if (waitTimeoutResolution.error) {
    await stepLogCompleteStep({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "error",
      error: waitTimeoutResolution.error,
    });
    return {
      success: false,
      error: waitTimeoutResolution.error,
    };
  }

  const explicitHookToken =
    typeof config.waitHookToken === "string" && config.waitHookToken.trim()
      ? config.waitHookToken.trim()
      : undefined;
  const hookToken = explicitHookToken || generateWaitToken();

  const waitForEvents =
    typeof config.waitForEvents === "string" ? config.waitForEvents : undefined;
  const waitState = await createWaitStateStep({
    executionId,
    workflowId,
    runId,
    nodeId: context.nodeId,
    nodeName: context.nodeName,
    waitType: "hook",
    hookToken,
    waitUntilIso: waitTimeoutResolution.waitUntil?.toISOString(),
    correlationKey: eventContext?.correlationKey,
    metadata: {
      waitForEvents,
      waitMode: "hook",
      waitTimeout: config.waitTimeout,
    },
  });

  await workflowAuditStep({
    workflowId,
    executionId,
    eventType: "run_waiting",
    message: `Run waiting on hook in node '${context.nodeName}'`,
    metadata: {
      nodeId: context.nodeId,
      hookToken,
      waitForEvents,
      timeoutAt: waitTimeoutResolution.waitUntil?.toISOString(),
    },
  });

  let timedOut = false;
  let hookPayload: unknown;

  try {
    const timeoutMs = waitTimeoutResolution.waitUntil
      ? Math.max(waitTimeoutResolution.waitUntil.getTime() - Date.now(), 0)
      : undefined;

    const resumeEvent = await runtime.waitForEvent(
      `wait-hook-${context.nodeId}`,
      {
        event: "workflow/wait.signal",
        timeoutMs,
        ifExpression: [
          "async.data.executionId == event.data.executionId",
          `async.data.nodeId == '${escapeCelString(context.nodeId)}'`,
          `async.data.token == '${escapeCelString(hookToken)}'`,
          `async.data.signalType == 'wait-resume'`,
        ].join(" && "),
      }
    );
    timedOut = resumeEvent === null;
    hookPayload = resumeEvent;
  } catch (error) {
    await stepLogCompleteStep({
      logId: startLog.logId,
      startTime: startLog.startTime,
      status: "error",
      error: getErrorMessage(error),
    });
    throw error;
  }

  await markWaitStateStatusStep({
    waitStateId: waitState.id,
    status: timedOut ? "timed_out" : "resumed",
  });
  await markExecutionRunningStep({ executionId });

  await workflowAuditStep({
    workflowId,
    executionId,
    eventType: timedOut ? "run_timed_out" : "run_resumed",
    message: timedOut
      ? `Run timed out in hook wait node '${context.nodeName}'`
      : `Run resumed from hook in node '${context.nodeName}'`,
    metadata: {
      nodeId: context.nodeId,
      hookToken,
    },
  });

  const output = {
    waitType: "hook",
    hookToken,
    timedOut,
    resumedAt: new Date().toISOString(),
    payload: hookPayload,
  };

  await stepLogCompleteStep({
    logId: startLog.logId,
    startTime: startLog.startTime,
    status: "success",
    output,
  });

  return {
    success: true,
    data: output,
  };
}

/**
 * Main workflow executor function
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Main executor coordinates triggers, actions, branching, waits, and terminal run state.
export async function executeWorkflow(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime = DEFAULT_RUNTIME
) {
  const {
    graph,
    triggerInput = {},
    requestPayload,
    executionId,
    workflowId,
    workflowName,
    workflowRunId,
    dryRun = false,
    eventContext,
  } = input;
  const { nodes, edges } = toWorkflowGraphData(graph);

  const currentWorkflowRunId =
    workflowRunId || runtime.runId || executionId || undefined;

  const executionLogger = workflowExecutorLogger.with({
    workflowId: workflowId ?? null,
    workflowName: workflowName ?? null,
    executionId: executionId ?? null,
    workflowRunId: currentWorkflowRunId ?? null,
    dryRun,
  });

  executionLogger.info("Starting workflow execution", {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    hasExecutionId: !!executionId,
    hasWorkflowId: !!workflowId,
    dryRun,
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
      return triggerDefinition.label;
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
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Node execution requires type checking and error handling
  async function executeNode(
    nodeId: string,
    callStack: Set<string> = new Set()
  ) {
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

    if (callStack.has(nodeId)) {
      nodeLogger.debug("Skipping node already visited");
      return; // Prevent cycles
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
    const nextCallStack = new Set(callStack);
    nextCallStack.add(nodeId);

    const nodeName = getNodeName(node);
    const namedNodeLogger = nodeLogger.with({
      nodeName,
      nodeType: node.data.type,
    });

    // Skip disabled nodes
    if (node.data.enabled === false) {
      namedNodeLogger.info("Skipping disabled node");

      // Store null output for disabled nodes so downstream templates don't fail
      const sanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
      results[nodeId] = {
        success: true,
        data: null,
      };
      outputs[sanitizedNodeId] = {
        label: node.data.label || nodeId,
        data: null,
      };
      completedNodes.add(nodeId);
      downstreamReadyNodes.add(nodeId);

      const nextNodes = (edgesBySource.get(nodeId) || []).map(
        (edge) => edge.target
      );
      await Promise.all(
        nextNodes.map((nextNodeId) => executeNode(nextNodeId, nextCallStack))
      );
      inProgressNodes.delete(nodeId);
      return;
    }

    try {
      let result: ExecutionResult;

      if (node.data.type === "trigger") {
        namedNodeLogger.debug("Executing trigger node");

        const config = node.data.config;
        const configRecord = config;
        const triggerDefinition =
          resolveWorkflowTriggerDefinition(configRecord);
        let triggerData: Record<string, unknown> = {
          triggered: true,
          timestamp: Date.now(),
        };

        const mockInput = triggerDefinition.parseMockInput?.(configRecord);
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
            eventTypePath: triggerEvaluation.metadata?.eventTypePath,
            ignoredReason: ignoreReason,
          };

          namedNodeLogger.info("Trigger ignored by routing rules", {
            triggerType: triggerDefinition.type,
            eventType: triggerEvaluation.eventType,
            eventTypePath: triggerEvaluation.metadata?.eventTypePath,
            ignoredReason: ignoreReason,
          });
        }

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
      } else if (node.data.type === "action") {
        const config = node.data.config || {};
        const actionType = readConfigString(config, "actionType");
        const actionLogger = namedNodeLogger.with({
          actionType: actionType ?? null,
        });
        actionLogger.debug("Executing action node");

        // Check if action type is defined
        if (!actionType) {
          result = {
            success: false,
            error: `Action node "${node.data.label || node.id}" has no action type configured`,
          };
          results[nodeId] = result;
          actionLogger.error("Action node missing action type");
          return;
        }

        // Process templates in config, but keep conditions unprocessed for special handling
        const configWithoutCondition = { ...config };
        const originalCondition = config.condition;
        const originalRunCondition = config.runCondition;
        configWithoutCondition.condition = undefined;
        configWithoutCondition.runCondition = undefined;

        const processedConfig = processTemplates(
          configWithoutCondition,
          outputs
        );

        // Add back the original condition (unprocessed)
        if (originalCondition !== undefined) {
          processedConfig.condition = originalCondition;
        }
        if (originalRunCondition !== undefined) {
          processedConfig.runCondition = originalRunCondition;
        }

        // Build step context for logging (stepHandler will handle the logging)
        const stepContext: StepContext = {
          executionId,
          nodeId: node.id,
          nodeName: getNodeName(node),
          nodeType: actionType,
        };
        const runConditionExpression = processedConfig.runCondition;
        processedConfig.runCondition = undefined;
        const shouldEvaluateRunCondition =
          actionType !== "Condition" &&
          runConditionExpression !== undefined &&
          runConditionExpression !== null &&
          (typeof runConditionExpression !== "string" ||
            runConditionExpression.trim().length > 0);

        // Execute the action step with stepHandler (logging is handled inside)
        // IMPORTANT: We pass integrationId via config, not actual credentials
        // Steps fetch credentials internally using fetchCredentials(integrationId)
        actionLogger.debug("Calling executeActionStep", {
          hasRunCondition: shouldEvaluateRunCondition,
        });
        let stepResult: unknown;
        if (shouldEvaluateRunCondition) {
          const { result: shouldRun } = evaluateConditionExpression(
            runConditionExpression,
            outputs
          );

          if (!shouldRun) {
            stepResult = await executeSkippedAction({
              actionType,
              context: stepContext,
              reason: "run_condition_false",
              executionId,
              workflowId,
              eventContext,
              runCondition: runConditionExpression,
            });
          } else if (
            dryRun &&
            actionType !== "Condition" &&
            actionType !== "Wait"
          ) {
            stepResult = await executeDryRunAction({
              actionType,
              context: stepContext,
              executionId,
            });
          } else if (actionType === "Wait") {
            stepResult = await executeWaitAction({
              config: processedConfig,
              context: stepContext,
              runtime,
              executionId,
              workflowId,
              workflowRunId: currentWorkflowRunId,
              dryRun,
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
        } else if (
          dryRun &&
          actionType !== "Condition" &&
          actionType !== "Wait"
        ) {
          stepResult = await executeDryRunAction({
            actionType,
            context: stepContext,
            executionId,
          });
        } else if (actionType === "Wait") {
          stepResult = await executeWaitAction({
            config: processedConfig,
            context: stepContext,
            runtime,
            executionId,
            workflowId,
            workflowRunId: currentWorkflowRunId,
            dryRun,
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

        // Check if this is a condition node
        const isConditionNode =
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
              nextNodes.map((nextNodeId) =>
                executeNode(nextNodeId, nextCallStack)
              )
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
            nextNodes.map((nextNodeId) =>
              executeNode(nextNodeId, nextCallStack)
            )
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
    } finally {
      inProgressNodes.delete(nodeId);
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

    // Update execution record if we have an executionId
    if (executionId) {
      const finalStatus = finalSuccess ? "success" : "error";
      try {
        await logWorkflowComplete({
          executionId,
          status: finalStatus,
          output: finalOutput,
          error: Object.values(results).find((r) => !r.success)?.error,
          startTime: workflowStartTime,
        });
        executionLogger.debug("Updated execution record", {
          status: finalStatus,
        });
      } catch (error) {
        executionLogger.error("Failed to update execution record", {
          error,
        });
      }

      if (workflowId) {
        let runCompletedMessage: string;
        if (dryRun) {
          runCompletedMessage = finalSuccess
            ? "Dry run completed successfully"
            : "Dry run completed with errors";
        } else {
          runCompletedMessage = finalSuccess
            ? "Run completed successfully"
            : "Run completed with errors";
        }

        await workflowAuditStep({
          workflowId,
          executionId,
          eventType: finalSuccess ? "run_completed" : "run_failed",
          message: runCompletedMessage,
          metadata: {
            duration,
            resultCount: Object.keys(results).length,
            dryRun,
          },
        });
      }
    }

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

    // Update execution record with error if we have an executionId
    if (executionId) {
      try {
        await logWorkflowComplete({
          executionId,
          status: terminalStatus,
          error: errorMessage,
          startTime: workflowStartTime,
        });
      } catch (logError) {
        executionLogger.error("Failed to persist fatal execution error", {
          error: logError,
        });
      }

      if (workflowId) {
        let runFailedMessage: string;
        if (dryRun) {
          runFailedMessage = cancelled
            ? "Dry run cancelled"
            : "Dry run failed with fatal error";
        } else {
          runFailedMessage = cancelled
            ? "Run cancelled while waiting"
            : "Run failed with fatal error";
        }

        await workflowAuditStep({
          workflowId,
          executionId,
          eventType: cancelled ? "run_cancelled" : "run_failed",
          message: runFailedMessage,
          metadata: {
            error: errorMessage,
            dryRun,
          },
        });
      }
    }

    return {
      success: false,
      results,
      outputs,
      error: errorMessage,
      cancelled,
    };
  }
}
