/**
 * A config key that means a moment or a length of time, and what it reads.
 *
 * The Wait node's keys are the ones that have it (`WAIT_VALUE_TARGETS`), and two
 * sides ask this: the editor, to decide what its picker offers, and the save, to
 * refuse a token the key's parser cannot answer. One function so the menu and the
 * refusal cannot drift apart.
 */

import type { ReferenceField } from "#src/graph/node-references";

/** What a typed config key expects of the value written into it. */
export type ValueTargetType = "duration" | "timestamp";

/**
 * Whether a field serves a target of this type.
 *
 * `allowNumber` is the one axis the two callers differ on. A number serves either
 * target -- `parseDurationMs` reads it as milliseconds, `parseTimestampWithTimezone`
 * as a unix epoch -- so the save allows one. The picker does not offer one, because
 * a payload's numbers are nearly always amounts, and suggesting a price where a
 * length of time belongs is how a wait ends up five seconds long.
 *
 * A field of no declared type serves anything, because nothing is known against
 * it. That is the ordinary state of an action's output.
 */
export function targetAccepts(
  field: Pick<ReferenceField, "type" | "format">,
  targetType: ValueTargetType | undefined,
  options: { allowNumber: boolean }
): boolean {
  if (!(targetType && field.type)) {
    return true;
  }

  if (options.allowNumber && field.type === "number") {
    return true;
  }

  return field.type === targetType || field.format === targetType;
}
