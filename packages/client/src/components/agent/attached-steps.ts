/**
 * The steps a person attached to a message for the build agent, as the message
 * keeps them in its custom metadata. The thread draws them as chips, and the
 * chat request names their node ids, which the server reads as what "this
 * step" means in that message. A stored thread is read back through `Schema`,
 * because it comes from this browser's storage.
 */

import { Option, Schema } from "effect";

const attachedStepSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  number: Schema.optionalKey(Schema.Number),
});

export type AttachedStep = typeof attachedStepSchema.Type;

const decodeAttachedSteps = Schema.decodeUnknownOption(
  Schema.Struct({ attachedSteps: Schema.Array(attachedStepSchema) })
);

/** The key a message's custom metadata holds its attached steps under. */
export const ATTACHED_STEPS_KEY = "attachedSteps";

/** The steps a message's custom metadata names, or none. */
export function readAttachedSteps(custom: unknown): readonly AttachedStep[] {
  return Option.match(decodeAttachedSteps(custom), {
    onNone: () => [],
    onSome: (value) => value.attachedSteps,
  });
}

/** A step as its chip reads: "Step 4 · Send 24-hour reminder". */
export function attachedStepText(step: AttachedStep): string {
  return step.number === undefined
    ? step.label
    : `Step ${step.number} · ${step.label}`;
}
