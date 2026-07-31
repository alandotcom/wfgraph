/**
 * The JSON a workflow author types into a metadata field, as Clerk takes it.
 *
 * Create User and Update User both offer the two metadata boxes, so the reading
 * of them is written once here rather than twice beside the steps.
 */

import { readAs, StepFailure } from "@rova/core/plugin";
import { Effect, Schema } from "effect";

// Clerk stores any JSON object as user metadata, so a workflow author's pasted
// text only has to be a JSON object to be usable here.
const readClerkMetadata = readAs(Schema.Record(Schema.String, Schema.Unknown));

/**
 * A metadata box's contents, or nothing when the box was left empty.
 *
 * Text that is not a JSON object fails the step rather than being dropped: the
 * author meant to attach something, and a user created without it is a silent
 * wrong answer.
 */
export function parseClerkMetadata(
  value: string | undefined,
  fieldName: "publicMetadata" | "privateMetadata"
): Effect.Effect<Record<string, unknown> | undefined, StepFailure> {
  if (!value) {
    return Effect.succeed(undefined);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return Effect.fail(
      new StepFailure({ message: `Invalid JSON format for ${fieldName}` })
    );
  }

  const metadata = readClerkMetadata(parsed);

  return metadata
    ? Effect.succeed(metadata)
    : Effect.fail(
        new StepFailure({ message: `Invalid JSON format for ${fieldName}` })
      );
}
