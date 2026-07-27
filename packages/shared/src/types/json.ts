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

import { z } from "zod";

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
 * Validates a value parsed from JSON text as a plain object.
 *
 * Use this at a boundary where the text came from outside the program (a
 * request body, a stored config string). Values our own code produced are
 * already typed and need no parse.
 */
export const jsonObjectSchema: z.ZodType<JsonObject, JsonObject> = z.record(
  z.string(),
  z.json()
);
