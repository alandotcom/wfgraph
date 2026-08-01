/**
 * The sample payloads a workflow keeps for its test runs, on the entry node's
 * config beside the Lifecycle Rules.
 *
 * They are stored rather than typed each time so a builder testing an
 * appointment reminder fills the appointment once. A sample is data the editor
 * sends on a run request; nothing on the delivery path reads it, which is why it
 * sits outside `lifecycleRulesSchema` -- a rule is something the engine obeys.
 */

import { Schema } from "effect";
import { type JsonObject, jsonObjectSchema } from "#src/types/json";
import { readAs } from "#src/types/schema";

/**
 * A sample per Event, keyed by Event name, plus the one a run that names no
 * Event carries. Both are `optional` rather than `optionalKey` because the
 * editor writes this object in process, where a cleared field is a key holding
 * `undefined` (see `graph/schemas.ts` for the whole of that rule).
 */
export const testPayloadsSchema = Schema.Struct({
  byEvent: Schema.optional(Schema.Record(Schema.String, jsonObjectSchema)),
  manual: Schema.optional(jsonObjectSchema),
});

export type TestPayloads = typeof testPayloadsSchema.Type;

const readPayloads = readAs(testPayloadsSchema);

/**
 * The samples off an entry node's config, or undefined where it carries none.
 * Strictness lives in the graph schema, which decodes this shape as part of the
 * node it sits on.
 */
export function readTestPayloads(
  config: Record<string, unknown> | undefined
): TestPayloads | undefined {
  return readPayloads(config?.testPayloads);
}

/** The sample for one Event, or the Event-less one when no Event is named. */
export function testPayloadFor(
  payloads: TestPayloads | undefined,
  eventName: string | undefined
): JsonObject | undefined {
  return eventName ? payloads?.byEvent?.[eventName] : payloads?.manual;
}
