/**
 * The JSON a workflow author types into a PostHog property field.
 *
 * Capture Event and Identify Person both offer key-value rows and a JSON box,
 * so the reading of them is written once here rather than twice beside the
 * steps. Capture drops unreadable text so a bad box does not lose the event.
 * Identify fails the step, because a parser miss would otherwise look like
 * "no properties were authored".
 */

import {
  type JsonObject,
  readJsonValue,
  StepFailure,
} from "@wfgraph/core/plugin";
import { Effect, Result, Schema } from "effect";
import { isEmptyObject } from "es-toolkit/predicate";

const propertyEntriesSchema = Schema.Array(
  Schema.Struct({ name: Schema.String, value: Schema.String })
);

const decodePropertyEntries = Schema.decodeUnknownResult(
  propertyEntriesSchema,
  { errors: "all" }
);

type PropertyReadMode = "drop" | "fail";

function asObject(entries: JsonObject | undefined): JsonObject {
  return entries ?? {};
}

function namedEntries(
  entries: readonly { name: string; value: string }[]
): JsonObject {
  const properties: JsonObject = {};

  for (const entry of entries) {
    // A row the builder added and never named carries no property.
    if (entry.name.trim()) {
      properties[entry.name] = entry.value;
    }
  }

  return properties;
}

function readKeyValueProperties(
  entriesJson: string,
  invalid: PropertyReadMode
): Effect.Effect<JsonObject | undefined, StepFailure> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(entriesJson);
  } catch (error) {
    if (invalid === "fail") {
      return Effect.fail(
        new StepFailure({ message: "Properties is not valid JSON." })
      );
    }

    console.error("[PostHog] Failed to parse properties JSON:", error);
    return Effect.succeed(undefined);
  }

  const result = decodePropertyEntries(parsed);

  if (Result.isFailure(result)) {
    if (invalid === "fail") {
      return Effect.fail(
        new StepFailure({
          message: "Properties must be a list of { name, value } entries.",
        })
      );
    }

    console.error(
      "[PostHog] Properties must be a list of { name, value } entries:",
      result.failure.message
    );
    return Effect.succeed(undefined);
  }

  return Effect.succeed(namedEntries(result.success));
}

function readJsonProperties(
  text: string,
  invalid: PropertyReadMode
): Effect.Effect<JsonObject | undefined, StepFailure> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (invalid === "fail") {
      return Effect.fail(
        new StepFailure({
          message: "Properties JSON is not valid JSON.",
        })
      );
    }

    console.error("[PostHog] Failed to parse the properties JSON box:", error);
    return Effect.succeed(undefined);
  }

  const json = readJsonValue(parsed);

  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    if (invalid === "fail") {
      return Effect.fail(
        new StepFailure({
          message:
            "Properties JSON must hold a JSON object of property names to values.",
        })
      );
    }

    console.error(
      "[PostHog] The properties JSON box must hold a JSON object of property names to values."
    );
    return Effect.succeed(undefined);
  }

  return Effect.succeed(json);
}

/**
 * One property bag out of the two fields that feed it.
 *
 * Each source is read on its own, so a dropped JSON box does not wipe rows that
 * parsed. The JSON box goes on last, so a builder can override a single key the
 * key-value rows set without rewriting the rows as JSON. Answers `undefined`
 * when neither field contributed anything, which keeps the key off the wire
 * rather than sending an empty object.
 */
export function readProperties(
  entriesJson: string | undefined,
  text: string | undefined,
  invalid: PropertyReadMode
): Effect.Effect<JsonObject | undefined, StepFailure> {
  return Effect.gen(function* () {
    const fromRows = entriesJson
      ? yield* readKeyValueProperties(entriesJson, invalid)
      : undefined;
    const fromJson = text?.trim()
      ? yield* readJsonProperties(text, invalid)
      : undefined;
    const merged: JsonObject = {
      ...asObject(fromRows),
      ...asObject(fromJson),
    };

    return isEmptyObject(merged) ? undefined : merged;
  });
}
