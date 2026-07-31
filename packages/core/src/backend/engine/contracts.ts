/**
 * What the engine's parts hand each other: one node's outcome, and what every
 * finished node left behind.
 *
 * A leaf, so the Wait node can be read and tested without the scheduler that
 * calls it.
 */

import type { getAppLogger } from "#src/backend/lib/logger";
import type { StepResult } from "@rova/shared/actions/step-result";
import type { JsonValue } from "@rova/shared/types/json";

/** The logger a run carries, already holding that run's own fields. */
export type RunLogger = ReturnType<ReturnType<typeof getAppLogger>["with"]>;

/**
 * What one node left behind, as the traversal reads it.
 *
 * A step's own envelope, so a dispatched action's answer needs no translation to
 * become a node outcome and `{ success: true, error: "..." }` does not compile.
 * `haltBranch` is how a node that succeeded says nothing below it should run,
 * which is what a skipped Wait answers with. It sits on the success arm alone:
 * a node that failed has already stopped everything below it, so the flag on a
 * failure would carry no meaning for a reader to act on.
 */
export type ExecutionResult =
  | Extract<StepResult, { success: false }>
  | (Extract<StepResult, { success: true }> & { haltBranch?: boolean });

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

/** The payload a node left, or nothing for a node that failed. */
export function executionData(result: ExecutionResult | undefined): unknown {
  return result !== undefined && result.success ? result.data : undefined;
}
