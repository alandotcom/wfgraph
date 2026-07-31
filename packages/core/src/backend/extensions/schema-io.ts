/**
 * What both authoring functions do with an author's schema, written once.
 *
 * `defineAction` and `defineStep` accept a schema from any Standard Schema
 * library, so each of them validates a resolved config against it and derives
 * the editor's config form from its JSON Schema. Validation must be synchronous:
 * a step boundary answers the engine and has no await to spend.
 */

import { Result } from "effect";
import type { ActionConfigFieldBase } from "@rova/shared/plugins/action-fields";
import {
  configFieldsFromJsonSchema,
  jsonSchemaLibraryOptions,
} from "@rova/shared/graph/schema-codec";
import { formatStandardIssuePath } from "@rova/shared/types/schema-message";
import type { StandardSchema } from "@rova/shared/types/schema";

export function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/**
 * The resolved config as the handler reads it, or the paths that refused it.
 *
 * Paths and no messages: a foreign library words its own issues and is free to
 * quote the value in them, and this string is persisted as the node's run error.
 * What places the fault is the path.
 */
export function validateConfig<TPayload extends Record<string, unknown>>(
  schema: StandardSchema<TPayload>,
  payload: Record<string, unknown>
): Result.Result<TPayload, string> {
  const parsed = schema["~standard"].validate(payload);

  if (isPromiseLike(parsed)) {
    throw new Error(
      "A config schema must validate synchronously. Async Standard Schema validators are not supported."
    );
  }

  if (
    "issues" in parsed &&
    Array.isArray(parsed.issues) &&
    parsed.issues.length > 0
  ) {
    return Result.fail(
      parsed.issues
        .map((issue) => formatStandardIssuePath(issue.path))
        .join(", ")
    );
  }

  if (!("value" in parsed)) {
    return Result.fail("the schema answered with no value and no issue");
  }

  return Result.succeed(parsed.value);
}

/**
 * The config form a schema describes, or an empty list for a schema that cannot
 * say.
 *
 * A derivation failure is not a definition failure here: an author who wrote no
 * fields and whose schema describes none gets a node with no form, which is
 * correct for an action that takes no configuration.
 */
export function configFieldsFromInputSchema(
  schema: StandardSchema<unknown>
): ActionConfigFieldBase[] {
  try {
    const jsonSchema = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });
    return configFieldsFromJsonSchema(jsonSchema);
  } catch {
    return [];
  }
}
