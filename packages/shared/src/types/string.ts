/**
 * A string that carries something, from a value nobody validated.
 *
 * The runtime companion to `NonEmptyTrimmedString`: that one is the schema a wire
 * shape is decoded with, this one is for reading a lone value out of a JSON bag
 * where a decode would be the wrong tool -- an Entity Value at a payload path, a
 * field off a config the editor wrote. Both trim, and both treat whitespace as
 * nothing, so an entity read as `" appt_1"` is the same entity as `"appt_1"`.
 */
export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Orders two strings a person reads: a label in a menu, an integration name, a
 * node title. This is the one place `localeCompare` is written, so a sort over
 * text puts "Apple" before "banana" instead of after it, which is where
 * code-unit order puts every capital letter.
 *
 * Sorting identifiers, ids and enum values stays on code-unit order, because
 * those are compared for a stable result rather than read down a list.
 */
export function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

/**
 * Whether a string carries nothing a reader would see. Whitespace is blank, so
 * a field holding only spaces counts as unfilled.
 */
export function isBlank(value: string): boolean {
  return value.trim().length === 0;
}
