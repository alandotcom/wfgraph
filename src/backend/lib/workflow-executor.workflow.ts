/**
 * Workflow executor used by Inngest runtime.
 * Keeps node execution, templating, and logging behavior aligned with the builder.
 */

import {
  preValidateConditionExpression,
  validateConditionExpression,
} from "@/backend/lib/condition-validator";
import { getAppLogger } from "@/backend/lib/logger";
import { getErrorMessageAsync } from "@/shared/utils";
import { resolveWaitUntil } from "@/shared/utils/wait-time";
import { toWorkflowGraphData } from "@/shared/workflow/graph";
import type {
  SerializedWorkflowGraph,
  WorkflowNode,
} from "@/shared/workflow/types";
import {
  buildWebhookRoutingConfig,
  deriveWebhookEventContext,
  routeWebhookEvent,
} from "@/shared/workflow/webhook-routing";
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
import type { StepContext } from "./steps/step-handler";
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
  ) => Promise<unknown | null>;
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
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import
    importer: () => import("./steps/database-query") as Promise<any>,
    stepFunction: "databaseQueryStep",
  },
  "HTTP Request": {
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import
    importer: () => import("./steps/http-request") as Promise<any>,
    stepFunction: "httpRequestStep",
  },
  Condition: {
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import
    importer: () => import("./steps/condition") as Promise<any>,
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

/**
 * Helper to replace template variables in conditions
 */
function replaceTemplateVariable(
  match: string,
  nodeId: string,
  rest: string,
  outputs: NodeOutputs,
  evalContext: Record<string, unknown>,
  varCounter: { value: number }
): string {
  const sanitizedNodeId = nodeId.replace(/[^a-zA-Z0-9]/g, "_");
  const output = outputs[sanitizedNodeId];

  if (!output) {
    conditionLogger.warn("Condition output not found for node", {
      nodeId: sanitizedNodeId,
    });
    return match;
  }

  const dotIndex = rest.indexOf(".");
  let value: unknown;

  if (dotIndex === -1) {
    value = output.data;
  } else if (output.data === null || output.data === undefined) {
    value = undefined;
  } else {
    const fieldPath = rest.substring(dotIndex + 1);
    const fields = fieldPath.split(".");
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic data traversal
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
        conditionLogger.warn("Condition field access failed", {
          fieldPath,
        });
        value = undefined;
        break;
      }
    }
    if (value === undefined && current !== undefined) {
      value = current;
    }
  }

  const varName = `__v${varCounter.value}`;
  varCounter.value += 1;
  evalContext[varName] = value;
  return varName;
}

type ConditionEvalResult = {
  result: boolean;
  resolvedValues: Record<string, unknown>;
};

/**
 * Evaluate condition expression with template variable replacement
 * Uses Function constructor to evaluate user-defined conditions dynamically
 *
 * Security: Expressions are validated before evaluation to prevent code injection.
 * Only comparison operators, logical operators, and whitelisted methods are allowed.
 */
function evaluateConditionExpression(
  conditionExpression: unknown,
  outputs: NodeOutputs
): ConditionEvalResult {
  conditionLogger.debug("Evaluating condition expression", {
    conditionExpression,
  });

  if (typeof conditionExpression === "boolean") {
    return { result: conditionExpression, resolvedValues: {} };
  }

  if (typeof conditionExpression === "string") {
    // Pre-validate the expression before any processing
    const preValidation = preValidateConditionExpression(conditionExpression);
    if (!preValidation.valid) {
      conditionLogger.error("Condition pre-validation failed", {
        error: preValidation.error,
        conditionExpression,
      });
      return { result: false, resolvedValues: {} };
    }

    try {
      const evalContext: Record<string, unknown> = {};
      const resolvedValues: Record<string, unknown> = {};
      let transformedExpression = conditionExpression;
      const templatePattern = /\{\{@([^:]+):([^}]+)\}\}/g;
      const varCounter = { value: 0 };

      transformedExpression = transformedExpression.replace(
        templatePattern,
        (match, nodeId, rest) => {
          const varName = replaceTemplateVariable(
            match,
            nodeId,
            rest,
            outputs,
            evalContext,
            varCounter
          );
          // Store the resolved value with a readable key (the display text from the template)
          resolvedValues[rest] = evalContext[varName];
          return varName;
        }
      );

      // Validate the transformed expression before evaluation
      const validation = validateConditionExpression(transformedExpression);
      if (!validation.valid) {
        conditionLogger.error("Condition validation failed", {
          error: validation.error,
          conditionExpression,
          transformedExpression,
        });
        return { result: false, resolvedValues };
      }

      const varNames = Object.keys(evalContext);
      const varValues = Object.values(evalContext);

      // Safe to evaluate - expression has been validated
      // Only contains: variables (__v0, __v1), operators, literals, and whitelisted methods
      const evalFunc = new Function(
        ...varNames,
        `return (${transformedExpression});`
      );
      const result = evalFunc(...varValues);
      return { result: Boolean(result), resolvedValues };
    } catch (error) {
      conditionLogger.error("Condition evaluation failed", {
        error,
        conditionExpression,
      });
      return { result: false, resolvedValues: {} };
    }
  }

  return { result: Boolean(conditionExpression), resolvedValues: {} };
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
    const { result: evaluatedCondition, resolvedValues } =
      evaluateConditionExpression(originalExpression, outputs);
    conditionLogger.debug("Condition evaluation result", {
      evaluatedCondition,
      hasResolvedValues: Object.keys(resolvedValues).length > 0,
    });

    return await stepFn({
      condition: evaluatedCondition,
      // Include original expression and resolved values for logging purposes
      expression:
        typeof originalExpression === "string" ? originalExpression : undefined,
      values:
        Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined,
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
            return String(data);
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
  resolvedValues?: Record<string, unknown>;
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

  if (input.resolvedValues && Object.keys(input.resolvedValues).length > 0) {
    output.values = input.resolvedValues;
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

  // Build node and edge maps
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edgesBySource = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = edgesBySource.get(edge.source) || [];
    targets.push(edge.target);
    edgesBySource.set(edge.source, targets);
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

  // Helper to get a meaningful node name
  function getNodeName(node: WorkflowNode): string {
    if (node.data.label) {
      return node.data.label;
    }
    if (node.data.type === "action") {
      const actionType = node.data.config?.actionType as string;
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
      if (node.data.config?.triggerType === "Schedule") {
        return "Schedule";
      }

      if (node.data.config?.triggerType === "Webhook") {
        return "Webhook";
      }

      return "Trigger";
    }
    return node.data.type;
  }

  // Helper to execute a single node
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Node execution requires type checking and error handling
  async function executeNode(nodeId: string, visited: Set<string> = new Set()) {
    const nodeLogger = executionLogger.with({ nodeId });
    nodeLogger.debug("Executing node");

    if (visited.has(nodeId)) {
      nodeLogger.debug("Skipping node already visited");
      return; // Prevent cycles
    }
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) {
      nodeLogger.warn("Node not found");
      return;
    }
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
      outputs[sanitizedNodeId] = {
        label: node.data.label || nodeId,
        data: null,
      };

      const nextNodes = edgesBySource.get(nodeId) || [];
      await Promise.all(
        nextNodes.map((nextNodeId) => executeNode(nextNodeId, visited))
      );
      return;
    }

    try {
      let result: ExecutionResult;

      if (node.data.type === "trigger") {
        namedNodeLogger.debug("Executing trigger node");

        const config = node.data.config;
        let triggerData: Record<string, unknown> = {
          triggered: true,
          timestamp: Date.now(),
        };

        // Handle webhook mock request for test runs
        const webhookMockRequest =
          config?.triggerType === "Webhook" &&
          typeof config.webhookMockRequest === "string"
            ? config.webhookMockRequest
            : undefined;

        if (
          config?.triggerType === "Webhook" &&
          webhookMockRequest &&
          (!triggerInput || Object.keys(triggerInput).length === 0)
        ) {
          try {
            const mockData = JSON.parse(webhookMockRequest);
            if (
              mockData &&
              typeof mockData === "object" &&
              !Array.isArray(mockData)
            ) {
              triggerData = { ...triggerData, ...mockData };
              namedNodeLogger.debug("Using webhook mock request payload", {
                mockData,
              });
            }
          } catch (error) {
            namedNodeLogger.error("Failed to parse webhook mock request", {
              error,
            });
          }
        } else if (triggerInput && Object.keys(triggerInput).length > 0) {
          // Use provided trigger input
          triggerData = { ...triggerData, ...triggerInput };
        }

        if (config?.triggerType === "Webhook") {
          const routing = buildWebhookRoutingConfig(config);
          const eventTypePath = routing.eventTypePath;
          const { eventType } = deriveWebhookEventContext(triggerData, routing);
          const routingDecision = routeWebhookEvent({
            eventType,
            routing,
          });

          let ignoreReason: string | undefined;
          if (routingDecision.kind === "delete") {
            ignoreReason = "stop_event";
          } else if (routingDecision.kind === "ignore") {
            ignoreReason = routingDecision.reason;
          }

          if (ignoreReason) {
            triggerData = {
              ...triggerData,
              triggered: false,
              eventType,
              eventTypePath,
              ignoredReason: ignoreReason,
            };

            namedNodeLogger.info("Webhook trigger ignored by routing rules", {
              eventType,
              eventTypePath,
              ignoredReason: ignoreReason,
            });
          }
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
        const actionType = config.actionType as string | undefined;
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
          const { result: shouldRun, resolvedValues } =
            evaluateConditionExpression(runConditionExpression, outputs);

          if (!shouldRun) {
            stepResult = await executeSkippedAction({
              actionType,
              context: stepContext,
              reason: "run_condition_false",
              executionId,
              workflowId,
              eventContext,
              runCondition: runConditionExpression,
              resolvedValues,
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
        const isErrorResult =
          stepResult &&
          typeof stepResult === "object" &&
          "success" in stepResult &&
          (stepResult as { success: boolean }).success === false;

        if (isErrorResult) {
          const errorResult = stepResult as {
            success: false;
            error?: string | { message: string };
          };
          // Support both old format (error: string) and new format (error: { message: string })
          const errorMessage =
            typeof errorResult.error === "string"
              ? errorResult.error
              : errorResult.error?.message ||
                `Step "${actionType}" in node "${node.data.label || node.id}" failed without a specific error message.`;
          result = {
            success: false,
            error: errorMessage,
          };
        } else {
          const haltBranch =
            typeof stepResult === "object" &&
            stepResult !== null &&
            "haltBranch" in stepResult &&
            (stepResult as { haltBranch?: unknown }).haltBranch === true;

          result = {
            success: true,
            data: stepResult,
            haltBranch,
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

      namedNodeLogger.info("Node execution completed", {
        success: result.success,
        haltBranch: result.haltBranch === true,
        error: result.error,
      });

      // Execute next nodes
      if (result.success) {
        // Webhook trigger routing may intentionally ignore an event.
        if (
          node.data.type === "trigger" &&
          result.data &&
          typeof result.data === "object" &&
          (result.data as { triggered?: unknown }).triggered === false
        ) {
          namedNodeLogger.info(
            "Skipping downstream nodes because trigger was not fired"
          );
          return;
        }

        if (result.haltBranch) {
          namedNodeLogger.info(
            "Skipping downstream nodes because step requested halt"
          );
          return;
        }

        // Check if this is a condition node
        const isConditionNode =
          node.data.type === "action" &&
          node.data.config?.actionType === "Condition";

        if (isConditionNode) {
          // For condition nodes, only execute next nodes if condition is true
          const conditionResult = (result.data as { condition?: boolean })
            ?.condition;
          namedNodeLogger.debug("Condition node result", {
            conditionResult,
          });

          if (conditionResult === true) {
            const nextNodes = edgesBySource.get(nodeId) || [];
            namedNodeLogger.debug(
              "Condition true, executing downstream nodes in parallel",
              {
                nextNodeCount: nextNodes.length,
                nextNodeIds: nextNodes,
              }
            );
            // Execute all next nodes in parallel
            await Promise.all(
              nextNodes.map((nextNodeId) => executeNode(nextNodeId, visited))
            );
          } else {
            namedNodeLogger.debug("Condition false, skipping downstream nodes");
          }
        } else {
          // For non-condition nodes, execute all next nodes in parallel
          const nextNodes = edgesBySource.get(nodeId) || [];
          namedNodeLogger.debug("Executing downstream nodes in parallel", {
            nextNodeCount: nextNodes.length,
            nextNodeIds: nextNodes,
          });
          // Execute all next nodes in parallel
          await Promise.all(
            nextNodes.map((nextNodeId) => executeNode(nextNodeId, visited))
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
      // Note: stepHandler already logged the error for action steps
      // Trigger steps don't throw, so this catch is mainly for unexpected errors
    }
  }

  // Execute from each trigger node in parallel
  try {
    executionLogger.info("Starting execution from trigger nodes");
    const workflowStartTime = Date.now();

    await Promise.all(triggerNodes.map((trigger) => executeNode(trigger.id)));

    const finalSuccess = Object.values(results).every((r) => r.success);
    const duration = Date.now() - workflowStartTime;

    executionLogger.info("Workflow execution completed", {
      success: finalSuccess,
      resultCount: Object.keys(results).length,
      durationMs: duration,
    });

    // Update execution record if we have an executionId
    if (executionId) {
      const finalStatus = finalSuccess ? "success" : "error";
      try {
        await triggerStep({
          triggerData: {},
          _workflowComplete: {
            executionId,
            status: finalStatus,
            output: Object.values(results).at(-1)?.data,
            error: Object.values(results).find((r) => !r.success)?.error,
            startTime: workflowStartTime,
          },
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
        await triggerStep({
          triggerData: {},
          _workflowComplete: {
            executionId,
            status: terminalStatus,
            error: errorMessage,
            startTime: Date.now(),
          },
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
