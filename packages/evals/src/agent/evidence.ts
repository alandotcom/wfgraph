import type { AgentEvalDocument } from "#src/agent/result";
import { parseWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import {
  readJsonObject,
  type JsonObject,
  type JsonSafe,
  type JsonValue,
} from "@wfgraph/shared/types/json";

type OptionalKeys<Value extends object> = {
  [Key in keyof Value]-?: Pick<Value, Key> extends Required<Pick<Value, Key>>
    ? never
    : Key;
}[keyof Value];

type Flatten<Value> = { -readonly [Key in keyof Value]: Value[Key] };

const omittedObjectProperty = Symbol("omittedObjectProperty");

type NormalizedValue = JsonValue | typeof omittedObjectProperty;

function rejectJsonValue(): never {
  throw new TypeError("Value is not JSON serializable");
}

function hasUnsupportedObjectType(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Error ||
    value instanceof Promise
  );
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

/** Copies a value while enforcing the JSON boundary at every nested field. */
function normalizeJsonValue(
  value: unknown,
  location: "array" | "object" | "root",
  ancestors: WeakSet<object>
): NormalizedValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : rejectJsonValue();
  }
  if (value === undefined) {
    return location === "object" ? omittedObjectProperty : rejectJsonValue();
  }
  if (typeof value !== "object") {
    return rejectJsonValue();
  }
  if (
    hasUnsupportedObjectType(value) ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    ancestors.has(value)
  ) {
    return rejectJsonValue();
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key) => !isArrayIndex(key, value.length))) {
        return rejectJsonValue();
      }
      return Array.from(value, (item) => {
        const normalized = normalizeJsonValue(item, "array", ancestors);
        return normalized === omittedObjectProperty
          ? rejectJsonValue()
          : normalized;
      });
    }

    const normalized: JsonObject = {};
    for (const key of Object.keys(value)) {
      const propertyValue: unknown = Reflect.get(value, key);
      const property = normalizeJsonValue(propertyValue, "object", ancestors);
      if (property !== omittedObjectProperty) {
        Object.defineProperty(normalized, key, {
          configurable: true,
          enumerable: true,
          value: property,
          writable: true,
        });
      }
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

/** The JSON representation produced after undefined object fields are removed. */
export type JsonNormalized<
  Value,
  UndefinedValue = never,
> = unknown extends Value
  ? JsonValue
  : Value extends string | number | boolean | null
    ? Value
    : Value extends undefined
      ? UndefinedValue
      : Value extends readonly (infer Element)[]
        ? JsonNormalized<Element, UndefinedValue>[]
        : Value extends object
          ? string extends keyof Value
            ? JsonObject
            : Flatten<
                {
                  -readonly [Key in Exclude<
                    keyof Value,
                    OptionalKeys<Value>
                  >]: JsonNormalized<Value[Key], UndefinedValue>;
                } & {
                  -readonly [Key in OptionalKeys<Value>]?: JsonNormalized<
                    Exclude<Value[Key], undefined>,
                    UndefinedValue
                  >;
                }
              >
          : never;

/** Converts typed evidence to the JSON value stored in eval output and artifacts. */
export function normalizeJsonEvidence<Value>(
  value: Value & JsonSafe<Value>,
  name: string
): JsonNormalized<Value> {
  try {
    const normalized = normalizeJsonValue(value, "root", new WeakSet());
    if (normalized === omittedObjectProperty) {
      return rejectJsonValue();
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The recursive copy enforces JsonValue, while `JsonNormalized` preserves the caller's narrower field types.
    return normalized as JsonNormalized<Value>;
  } catch {
    throw new Error(`${name} is not JSON serializable.`);
  }
}

/** Converts typed object evidence to a JSON object. */
export function normalizeJsonObjectEvidence<Value extends object>(
  value: Value & JsonSafe<Value>,
  name: string
): JsonNormalized<Value> {
  const normalized = normalizeJsonEvidence<Value>(value, name);
  if (readJsonObject(normalized) === null) {
    throw new Error(`${name} is not JSON serializable.`);
  }
  return normalized;
}

/** Normalizes the final graph and checks the shape consumed by eval judges. */
export function normalizeAgentEvalDocument(
  value: unknown
): JsonNormalized<AgentEvalDocument> {
  const normalized = normalizeJsonEvidence(value, "Agent eval final document");
  try {
    const document = parseWorkflowGraphData(normalized);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `normalized` proved every retained leaf is JSON, and the shared parser only removes fields.
    return document as JsonNormalized<AgentEvalDocument>;
  } catch (error) {
    throw new Error(
      `Agent eval final document has an invalid graph shape: ${error instanceof Error ? error.message : "Invalid graph data"}`,
      { cause: error }
    );
  }
}
