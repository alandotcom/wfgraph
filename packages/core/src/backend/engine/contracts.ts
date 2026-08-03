/**
 * What the engine's parts hand each other: one node's outcome, and what every
 * finished node left behind.
 *
 * A leaf, so the Wait node can be read and tested without the scheduler that
 * calls it.
 */

import type { StepResult } from "@rova/shared/actions/step-result";
import type { JsonValue } from "@rova/shared/types/json";
import {
  type EngineFailure,
  engineFailure,
} from "#src/backend/engine/engine-failure";

export type ExecutionResult =
  | Extract<StepResult, { success: true }>
  | { success: false; error: EngineFailure };

/** A step's result as the richer failure value the engine carries internally. */
export function executionResultFromStepResult(
  result: StepResult
): ExecutionResult {
  return result.success
    ? result
    : {
        success: false,
        error: engineFailure("failure", result.error.message),
      };
}

/** A node that failed before it could answer with a step result. */
export function failedExecution(failure: EngineFailure): ExecutionResult {
  return { success: false, error: failure };
}

/**
 * What each finished node left behind, keyed by node id.
 *
 * `data` is JSON because it has already crossed a serialization boundary by the
 * time anything reads it: Inngest memoizes a step's return value between steps,
 * and a resumed run reads back what it decoded. Saying so here is what lets the
 * template resolver and the CEL context walk a value with plain language checks
 * rather than a hand-rolled shape predicate.
 */
export type NodeOutputs = Record<string, { label: string; data: JsonValue }>;

/** The sentence a failed node left, or nothing for a node that succeeded. */
export function executionError(
  result: ExecutionResult | undefined
): string | undefined {
  return result === undefined || result.success
    ? undefined
    : result.error.message;
}

/** The typed failure a failed node left, or nothing for a successful node. */
export function executionFailure(
  result: ExecutionResult | undefined
): EngineFailure | undefined {
  return result === undefined || result.success ? undefined : result.error;
}

/** The payload a node left, or nothing for a node that failed. */
export function executionData(result: ExecutionResult | undefined): unknown {
  return result !== undefined && result.success ? result.data : undefined;
}

/**
 * A node's stored row output, as the traversal holds one.
 *
 * The two are a wrapper apart. `runWithStepLog` writes the row with the step's
 * own payload, while the traversal holds the `{ success, data }` envelope around
 * it and every reader steps through that envelope with `unwrapStepOutput`. A row
 * read back is therefore wrapped again, so one shape reaches a template whether
 * the node ran in this run or in the one that handed this branch off. A payload
 * that is itself `{ success, data }` is what makes the difference visible: read
 * bare, it would be unwrapped a second time and a template would resolve against
 * the wrong object.
 */
export function wrapStoredOutput(data: JsonValue): JsonValue {
  return { success: true, data };
}
