/**
 * The shape of anything that arrived as JSON: a webhook body, a sample payload
 * a user pasted into the editor, a stored config string read back with
 * `JSON.parse`.
 *
 * Code that walks such a value should take `JsonValue` for its parameter.
 * TypeScript then narrows the union with plain language checks, so a
 * `typeof value === "object" && value !== null && !Array.isArray(value)` test
 * yields `JsonObject` on its own and no shape predicate is needed.
 */

import { Schema } from "effect";
import { z } from "zod";
import { readAs } from "#src/types/schema";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON value that is a plain object, the shape a payload root must have. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * `Schema.MutableJson` is the same union `JsonValue` spells out by hand, and it
 * validates the whole tree without rebuilding it, so a value that passes comes
 * back as the object that went in. `Schema.Json` is its readonly twin and would
 * fight every consumer here, all of which hold `JsonValue`.
 */
const readJson = readAs(Schema.MutableJson);

/**
 * Reads a value the type system lost track of back as JSON.
 *
 * The engine dispatches a step through a dynamic import, so a step's payload
 * arrives as `unknown` however precisely the step declared it. By the time the
 * engine files that payload as a node output it has already been through
 * Inngest's step memoization, which serializes it, so it is JSON in fact. This
 * turns that fact back into a type, and answers `null` for a value that is not
 * JSON so a plugin returning a Date is caught where it happened.
 */
export function readJsonValue(value: unknown): JsonValue | null {
  return readJson(value) ?? null;
}

/**
 * The same read, narrowed to the plain object a payload root must be.
 *
 * Use this at a boundary where the value came from outside the program: a
 * request body, a mock request the editor stored as text, the `data` an Inngest
 * event carried. An array, a bare string or `null` says nothing a payload can
 * be read from, so all three come back as `null`.
 *
 * The narrowing is the language's, working on the union `readJsonValue` already
 * proved: once a value is a `JsonValue`, ruling out `null` and the array arm
 * leaves `JsonObject` and nothing else. This is the case the header describes,
 * where a shape predicate would only restate what the compiler already knows.
 */
export function readJsonObject(value: unknown): JsonObject | null {
  const json = readJsonValue(value);

  return json !== null && typeof json === "object" && !Array.isArray(json)
    ? json
    : null;
}

/**
 * The same shape in Zod, for the schemas that have not moved yet: the oRPC
 * contracts in `rpc/contracts.ts` and the Inngest event types in
 * `backend/lib/inngest/events.ts` both embed it inside a Zod object. Delete
 * this in batch B, when those two move to Effect Schema.
 */
export const jsonObjectZodSchema: z.ZodType<JsonObject, JsonObject> = z.record(
  z.string(),
  z.json()
);
