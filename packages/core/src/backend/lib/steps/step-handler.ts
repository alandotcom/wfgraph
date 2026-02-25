/**
 * Step Handler - Logging utilities for workflow builder UI
 * Uses direct database calls for security (no HTTP endpoint)
 */

import { getAppLogger } from "@/backend/lib/logger";
import { redactSensitiveData } from "@/backend/lib/utils/redact";
import {
  logStepCompleteDb,
  logStepStartDb,
  logWorkflowCompleteDb,
} from "@/backend/lib/workflow-logging";

const stepHandlerLogger = getAppLogger("workflow", "step-handler");

export type StepContext = {
  executionId?: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  runMode?: "live" | "test";
};

/**
 * Base input type that all steps should extend
 * Adds optional _context for logging
 */
export type StepInput = {
  _context?: StepContext;
};

type StepInputWithInternalFields = StepInput & {
  actionType?: unknown;
  integrationId?: unknown;
};

type LogInfo = {
  logId: string;
  startTime: number;
};

/**
 * Log the start of a step execution
 */
async function logStepStart(
  context: StepContext | undefined,
  input: unknown
): Promise<LogInfo> {
  if (!context?.executionId) {
    return { logId: "", startTime: Date.now() };
  }

  try {
    const redactedInput = redactSensitiveData(input);

    const result = await logStepStartDb({
      executionId: context.executionId,
      nodeId: context.nodeId,
      nodeName: context.nodeName,
      nodeType: context.nodeType,
      input: redactedInput,
    });

    return result;
  } catch (error) {
    stepHandlerLogger.warn("Failed to log step start", {
      executionId: context.executionId,
      nodeId: context.nodeId,
      nodeName: context.nodeName,
      nodeType: context.nodeType,
      error,
    });
    return { logId: "", startTime: Date.now() };
  }
}

/**
 * Log the completion of a step execution
 */
async function logStepComplete(
  logInfo: LogInfo,
  status: "success" | "error",
  output?: unknown,
  error?: string
): Promise<void> {
  if (!logInfo.logId) {
    return;
  }

  try {
    const redactedOutput = redactSensitiveData(output);

    await logStepCompleteDb({
      logId: logInfo.logId,
      startTime: logInfo.startTime,
      status,
      output: redactedOutput,
      error,
    });
  } catch (err) {
    stepHandlerLogger.warn("Failed to log step completion", {
      logId: logInfo.logId,
      status,
      error: err,
    });
  }
}

/**
 * Strip internal fields from input for logging (we don't want to log internal metadata)
 */
function stripInternalFields<T extends StepInputWithInternalFields>(
  input: T
): Omit<T, "_context" | "actionType" | "integrationId"> {
  const {
    _context: _ignoredContext,
    actionType: _ignoredActionType,
    integrationId: _ignoredIntegrationId,
    ...result
  } = input;

  return result;
}

/**
 * Log workflow execution completion
 * Call this from within a step context to update the overall workflow status
 */
export async function logWorkflowComplete(options: {
  executionId: string;
  status: "success" | "error" | "cancelled";
  output?: unknown;
  error?: string;
  startTime: number;
}): Promise<void> {
  try {
    const redactedOutput = redactSensitiveData(options.output);

    await logWorkflowCompleteDb({
      executionId: options.executionId,
      status: options.status,
      output: redactedOutput,
      error: options.error,
      startTime: options.startTime,
    });
  } catch (err) {
    stepHandlerLogger.warn("Failed to log workflow completion", {
      executionId: options.executionId,
      status: options.status,
      error: err,
    });
  }
}

/**
 * Extended context that includes workflow completion info
 */
export type StepContextWithWorkflow = StepContext & {
  _workflowComplete?: {
    status: "success" | "error" | "cancelled";
    output?: unknown;
    error?: string;
    startTime: number;
  };
};

/**
 * Extended input type for steps that may handle workflow completion
 */
export type StepInputWithWorkflow = {
  _context?: StepContextWithWorkflow;
};

type StandardizedStepResult =
  | { success: true; data?: unknown }
  | { success: false; error?: string | { message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStandardizedStepResult(
  value: unknown
): value is StandardizedStepResult {
  if (!isRecord(value) || typeof value.success !== "boolean") {
    return false;
  }

  if (value.success) {
    return true;
  }

  if (!("error" in value) || value.error === undefined) {
    return true;
  }

  return (
    typeof value.error === "string" ||
    (isRecord(value.error) && typeof value.error.message === "string")
  );
}

function hasWorkflowCompleteContext(
  context: StepContext | undefined
): context is StepContextWithWorkflow {
  return (
    typeof context === "object" &&
    context !== null &&
    "_workflowComplete" in context
  );
}

/**
 * Wrap step logic with logging
 * If _context._workflowComplete is set, also logs workflow completion
 *
 * @example
 * export async function myStep(input: MyInput & StepInput) {
 *   return withStepLogging(input, async () => {
 *     // your step logic here
 *     return { success: true, data: ... };
 *   });
 * }
 */
export async function withStepLogging<TInput extends StepInput, TOutput>(
  input: TInput,
  stepLogic: () => Promise<TOutput>
): Promise<TOutput> {
  // Extract context and log input without internal fields
  const context = input._context;
  const loggedInput = stripInternalFields(input);
  const logInfo = await logStepStart(context, loggedInput);

  try {
    const result = await stepLogic();
    const standardizedResult = isStandardizedStepResult(result)
      ? result
      : undefined;

    if (standardizedResult?.success === false) {
      // Support both old format (error: string) and new format (error: { message: string })
      const errorMessage =
        typeof standardizedResult.error === "string"
          ? standardizedResult.error
          : standardizedResult.error?.message || "Step execution failed";
      // Log just the error object, not the full result
      const loggedOutput = standardizedResult.error ?? {
        message: errorMessage,
      };
      await logStepComplete(logInfo, "error", loggedOutput, errorMessage);
    } else if (standardizedResult?.success === true) {
      // For standardized success results, log just the data
      await logStepComplete(
        logInfo,
        "success",
        standardizedResult.data ?? standardizedResult
      );
    } else {
      // For non-standardized results, log as-is
      await logStepComplete(logInfo, "success", result);
    }

    // If this step should also log workflow completion, do it now
    if (
      hasWorkflowCompleteContext(context) &&
      context._workflowComplete &&
      context.executionId
    ) {
      await logWorkflowComplete({
        executionId: context.executionId,
        ...context._workflowComplete,
      });
    }

    return result;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    await logStepComplete(logInfo, "error", undefined, errorMessage);
    throw error;
  }
}
