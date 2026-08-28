/**
 * The stored value of a `provider-fields` config field, read the one way.
 *
 * The field writes one JSON object under one config key, and three places have
 * to agree about what that text holds: the config panel draws a form over it,
 * the issue collector judges a node against it, and the engine resolves each of
 * its values as its own template before the step sees it. They each carried a
 * copy of this reader, and the copies had drifted apart on which values counted,
 * so a shape one accepted another silently handed back to the fallback path.
 *
 * Scalars only, because that is what the boundary can carry: a value here is
 * either text the builder authored, which may hold template tokens the engine
 * resolves, or a number the provider declared. Anything else, including a nested
 * object or a boolean, answers as unreadable, which is how each caller knows to
 * hand the raw text back to the person who wrote it rather than guess at it.
 *
 * Blank text is unreadable rather than empty on purpose. "Nothing stored yet"
 * and "an object with no members" are different instructions at the step
 * boundary, so the caller that wants the first says so itself.
 */

/** One provider-backed field's values, keyed by the variable each fills. */
export type ProviderFieldValues = Record<string, string | number>;

/** The object of scalars this text holds, or nothing when it holds anything else. */
export function readProviderFieldValues(
  text: string
): ProviderFieldValues | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const values: ProviderFieldValues = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string" && typeof value !== "number") {
      return null;
    }
    values[key] = value;
  }
  return values;
}

/**
 * Whether a value is present for one variable.
 *
 * A number counts. The panel stores a variable the provider declared `number` as
 * a JSON number, so reading presence as "is a non-blank string" reported a filled
 * numeric variable as missing and blocked the publish with the value on screen.
 */
export function hasProviderFieldValue(
  values: ProviderFieldValues,
  key: string
): boolean {
  const value = values[key];
  if (typeof value === "number") {
    return true;
  }
  return typeof value === "string" && value.trim().length > 0;
}
