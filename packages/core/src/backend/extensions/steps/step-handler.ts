/**
 * The run context the engine hands a step, and the reader that recovers it.
 *
 * The run log rows are the engine's, written through its `WorkflowStore` port,
 * and the envelope is `defineStep`'s. What is left here is the run context.
 */

import { Schema } from "effect";
import { readAs } from "@wfgraph/shared/types/schema";

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
 * `undefined` would lose the whole thing, and `runMode` would fall back to
 * `"live"`, which for a step that sends an SMS is a test run reaching a real
 * phone.
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

/** The connected integration's id out of a step's input record, or undefined when it has none. */
export function readIntegrationId(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Base input every step's record carries, whatever else the node configured. */
export type StepInput = {
  _context?: StepContext | undefined;
};

type StepInputWithInternalFields = StepInput & {
  actionType?: unknown;
  integrationId?: unknown;
};

/**
 * The step's own config, with the three keys the engine's dispatch owns removed.
 *
 * A run log shows what the node was configured with, so `_context` and the two
 * fields naming the action and its connection come out. A step that hands its
 * input to something an author wrote wants the same three gone, which is why this
 * is exported rather than private to the engine.
 */
export function stripInternalFields<T extends StepInputWithInternalFields>(
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
