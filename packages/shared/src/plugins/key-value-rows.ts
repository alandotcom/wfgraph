/**
 * The stored value of a `key-value` config field, read the one way.
 *
 * The widget writes one JSON string under one config key, holding a list of
 * `{ name, value }` rows, and three places have to agree about what that text
 * holds: the config panel draws the rows over it, the engine resolves each row's
 * value as its own template, and the step folds the rows into whatever the
 * system it calls wants. A copy of this reader in each is how the three drift
 * apart, which `provider-field-values.ts` beside this file says at more length.
 *
 * A list rather than an object, because a row is a row: two rows may carry the
 * same name, a name may be blank while somebody is still typing it, and the
 * order is the order they were added in. Text this cannot read answers `null`,
 * which is how each caller knows to hand it back to the person who wrote it
 * rather than guess.
 */

/** One row of the widget, exactly as it is stored. */
export type KeyValueRow = { name: string; value: string };

/** The rows this text holds, or nothing when it holds anything else. */
export function readKeyValueRows(text: string): KeyValueRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const rows: KeyValueRow[] = [];
  for (const entry of parsed) {
    if (!isKeyValueRow(entry)) {
      return null;
    }
    rows.push({ name: entry.name, value: entry.value });
  }
  return rows;
}

function isKeyValueRow(value: unknown): value is KeyValueRow {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "value" in value &&
    typeof value.name === "string" &&
    typeof value.value === "string"
  );
}
