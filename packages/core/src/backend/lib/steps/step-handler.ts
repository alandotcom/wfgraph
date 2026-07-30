/**
 * Step Handler - Logging utilities for workflow builder UI
 * Uses direct database calls for security (no HTTP endpoint)
 */

import { Schema } from "effect";
import { getAppLogger } from "#src/backend/lib/logger";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";
import { readAs } from "@rova/shared/types/schema";
import type { StepResult } from "@rova/shared/workflow/step-result";
import {
  logStepCompleteDb,
  logStepStartDb,
  logWorkflowCompleteDb,
} from "#src/backend/lib/workflow-logging";

const stepHandlerLogger = getAppLogger("workflow", "step-handler");

/**
 * What the engine tells a step about the run it is part of.
 *
 * The engine hands this over inside the step's input record, under `_context`,
 * so a step that narrows its own input has no compiler-checked path to it. The
 * schema is that path: `readStepContext` below decodes the field, and
 * `defineStep` hands what comes out to the handler.
 *
 * `optional`, not `optionalKey`, for the two fields the engine may leave empty.
 * A decode that fails answers with no context at all rather than with a context
 * missing one field, so a caller that spelled an empty value as a key holding
 * `undefined` would lose the whole thing: the run log rows would stop being
 * written, and `runMode` would fall back to `"live"`, which for a step that
 * sends an SMS is a test run reaching a real phone.
 */
const stepContextSchema = Schema.Struct({
  executionId: Schema.optional(Schema.String),
  nodeId: Schema.String,
  nodeName: Schema.String,
  nodeType: Schema.String,
  runMode: Schema.optional(Schema.Literals(["live", "test"])),
});

export type StepContext = typeof stepContextSchema.Type;

/** The run context out of a step's input record, or undefined when it has none. */
export const readStepContext = readAs(stepContextSchema);

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
  status: "completed" | "failed" | "canceled";
  output?: unknown;
  error?: string;
  startTime: number;
}): Promise<boolean> {
  try {
    const redactedOutput = redactSensitiveData(options.output);

    const recorded = await logWorkflowCompleteDb({
      executionId: options.executionId,
      status: options.status,
      output: redactedOutput,
      error: options.error,
      startTime: options.startTime,
    });

    if (!recorded) {
      stepHandlerLogger.info(
        "Run completion superseded by an earlier terminal status",
        {
          executionId: options.executionId,
          status: options.status,
        }
      );
    }

    return recorded;
  } catch (err) {
    stepHandlerLogger.warn("Failed to log workflow completion", {
      executionId: options.executionId,
      status: options.status,
      error: err,
    });
    // A transient write failure says nothing about who owns the terminal
    // status, so the caller still announces its own outcome.
    return true;
  }
}

/**
 * Wrap step logic with logging
 *
 * @example
 * export async function myStep(input: MyInput & StepInput) {
 *   return withStepLogging(input, async () => {
 *     // your step logic here
 *     return { success: true, data: ... };
 *   });
 * }
 */
export async function withStepLogging<TOutput extends StepResult>(
  input: StepInput,
  stepLogic: () => Promise<TOutput>
): Promise<TOutput> {
  // Extract context and log input without internal fields
  const context = input._context;
  const loggedInput = stripInternalFields(input);
  const logInfo = await logStepStart(context, loggedInput);

  try {
    const result = await stepLogic();

    if (result.success) {
      // A success logs its payload. A step that reports success without one has
      // nothing but the wrapper to show.
      await logStepComplete(logInfo, "success", result.data ?? result);
    } else {
      await logStepComplete(
        logInfo,
        "error",
        result.error,
        result.error.message
      );
    }

    return result;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    await logStepComplete(logInfo, "error", undefined, errorMessage);
    throw error;
  }
}
