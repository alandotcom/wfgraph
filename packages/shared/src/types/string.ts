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
