/**
 * The shape of anything that arrived as JSON: a webhook body, a sample payload
 * a user pasted into the editor, a stored config string read back with
 * `JSON.parse`.
 *
 * Code that walks such a value should take `JsonValue` for its parameter.
 * TypeScript narrows that union with plain language checks, so a
 * `typeof value === "object" && value !== null && !Array.isArray(value)` test
 * yields `JsonObject` on its own. `isJsonObject` gives that test a name, for
 * the modules that would otherwise repeat it.
 */

import { Schema } from "effect";
import { compact } from "es-toolkit/array";
import { isPlainObject } from "es-toolkit/predicate";
import { readAs } from "#src/types/schema";
import { omitUndefined } from "#src/utils/omit-undefined";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON value that is a plain object, the shape a payload root must have. */
export type JsonObject = { [key: string]: JsonValue };

/** What a rejected value is told, printed in full by the compiler. */
type NotJsonSafeMessage =
  "Not JSON-safe: a Date, Map, Set, RegExp, bigint, symbol or function is lost when the run resumes. Return an ISO string or plain JSON.";

/**
 * The built-in types `JSON.stringify` drops, empties, or throws on.
 *
 * `Error` is here because its `name`, `message` and `stack` are non-enumerable,
 * so it serializes to `{}` rather than to anything a reader could act on.
 */
type NotJsonSafe =
  | Date
  | RegExp
  | Map<unknown, unknown>
  | Set<unknown>
  | Error
  | Promise<unknown>
  | bigint
  | symbol
  | ((...args: never[]) => unknown);

/**
 * The same type with every unserializable leaf replaced by a sentence saying so.
 *
 * A signature whose value crosses a memoized step boundary takes
 * `T & JsonSafe<T>` for that value: the intersection is `T` itself when the
 * shape is JSON-safe, and collapses to the message above at the offending
 * property when it is not, so the compiler names the field rather than the run.
 *
 * The check refuses known-bad leaves rather than demanding assignability to
 * `JsonValue`, because TypeScript gives a type alias an implicit index signature
 * and an interface none. An SDK's `interface Appointment { id: string }` is JSON
 * in fact, and `extends JsonValue` would reject it.
 *
 * Two things get through. A value typed `unknown` or `any` has nothing to
 * inspect. A class holding only data reads as the object it serializes to, so
 * its fields arrive intact on the far side and its prototype does not.
 */
export type JsonSafe<T> = T extends
  | string
  | number
  | boolean
  | null
  | undefined
  | void
  ? T
  : T extends NotJsonSafe
    ? NotJsonSafeMessage
    : T extends readonly (infer Element)[]
      ? readonly JsonSafe<Element>[]
      : T extends object
        ? { [Key in keyof T]: JsonSafe<T[Key]> }
        : T;

/**
 * A JSON object as TypeScript writes one, before it is stored.
 *
 * An object literal says "no value for this key" with `undefined`, which JSON
 * has no spelling for, so a shape assembled from optional fields cannot be a
 * `JsonObject` until those keys are gone. `toJsonObject` is what takes them off.
 */
export type JsonObjectDraft = { [key: string]: JsonValue | undefined };

/**
 * The draft with its valueless keys removed, which is what `JSON.stringify`
 * would have done to them anyway.
 *
 * Takes `undefined` through unchanged, because both call sites hold an optional
 * draft and would otherwise repeat the `&&` guard at the call site.
 */
export function toJsonObject(
  draft: JsonObjectDraft | undefined
): JsonObject | undefined {
  return draft === undefined ? undefined : omitUndefined(draft);
}

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
 * A step's payload reaches the engine as `unknown` however precisely the step
 * declared it. By the time the engine files it as a node output it has been
 * through Inngest's step memoization, which serializes it, so it is JSON in
 * fact. This turns that fact back into a type, and answers `null` for a value
 * that is not JSON so a plugin returning a Date is caught where it happened.
 */
export function readJsonValue(value: unknown): JsonValue | null {
  return readJson(value) ?? null;
}

/**
 * Whether a `JsonValue` is the plain object arm of the union.
 *
 * es-toolkit's `isPlainObject` cannot do this job: it is typed
 * `value is Record<PropertyKey, any>`, and a JSON array is assignable to that,
 * so it narrows a `JsonValue` to a type that still admits an array.
 *
 * `undefined` is accepted and answers false, because a walk over a JSON tree
 * reaches a missing key before it reaches a value.
 */
export function isJsonObject(
  value: JsonValue | undefined
): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * leaves `JsonObject` and nothing else. `isJsonObject` names that check.
 */
export function readJsonObject(value: unknown): JsonObject | null {
  const json = readJsonValue(value);

  return json !== null && isJsonObject(json) ? json : null;
}

/**
 * Read every part of a value that JSON can carry, dropping the parts it cannot.
 *
 * A node config is JSON: it is stored in a JSONB column and read back with
 * `JSON.parse`. TypeScript still types a config the editor is holding as
 * `Record<string, unknown>`, and such a config carries `undefined` under a key
 * the editor cleared, which JSON has no spelling for. `readJsonObject` refuses
 * an object holding one whole, so a walk given its answer would miss every
 * template beside that key. This drops the key instead and keeps the rest.
 *
 * An array keeps its length, because a caller addressing an element by index
 * means the position it was written at: an element JSON cannot carry becomes
 * `null` rather than closing the gap.
 *
 * The result is a copy, so a caller comparing references sees a new object even
 * when nothing was dropped.
 */
export function readJsonObjectLeniently(value: unknown): JsonObject | null {
  const json = readJsonLeniently(value);

  return json !== undefined && isJsonObject(json) ? json : null;
}

function readJsonLeniently(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  // `JSON.stringify` writes a NaN or an Infinity as `null`, so that is what
  // reading one back gives.
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map((item) => readJsonLeniently(item) ?? null);
  }

  // The one narrowing of a bare `unknown` in this module. `isJsonObject` cannot
  // do it: its argument is a `JsonValue`, which is the fact this call is trying
  // to establish.
  if (!isPlainObject(value)) {
    return undefined;
  }

  // `Object.fromEntries` defines each key as an own property, so a config
  // holding a key named `__proto__` keeps it as data.
  return Object.fromEntries(
    compact(
      Object.entries(value).map(([key, nested]) => {
        const item = readJsonLeniently(nested);
        return item === undefined ? undefined : ([key, item] as const);
      })
    )
  );
}

/**
 * The same shape as a schema, for the payloads that are described rather than
 * read: the `input` an RPC procedure takes, the `startPayload` an Inngest event
 * carries. Those two embed it inside an object schema of their own, so it is a
 * schema here rather than a reader.
 *
 * `MutableJson` for the value, matching `JsonValue` above, and `Schema.Record`
 * for the root, which is the `JsonObject` narrowing stated as a schema.
 *
 * The annotation is the compiler proving that, and it is why the two
 * definitions cannot drift: widen either one and this line stops compiling.
 * What it checks is that a decoded value is assignable to `JsonObject`, which
 * is the direction every consumer reads in. It does not check the reverse:
 * `Schema.Record` describes an index signature, and `JsonObject`'s own index
 * signature is mutable, so the two are assignable one way only.
 */
export const jsonObjectSchema = Schema.Record(
  Schema.String,
  Schema.MutableJson
) satisfies Schema.Codec<JsonObject>;
