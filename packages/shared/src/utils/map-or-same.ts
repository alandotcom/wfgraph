/**
 * Map an array or a record, returning the input itself when every element
 * mapped to itself. A caller that reconciles during render reads the returned
 * reference as "nothing changed" and writes no state.
 */

/**
 * The mapped array, or `items` itself when `fn` returned every element with the
 * element it was given.
 */
export function mapOrSame<T>(
  items: T[],
  fn: (item: T, index: number) => T
): T[] {
  const next = items.map((item, index) => fn(item, index));

  if (next.every((item, index) => item === items[index])) {
    return items;
  }

  return next;
}

/**
 * The record with every value mapped, or `input` itself when `fn` returned
 * every value with the value it was given. Key order follows the input.
 *
 * Built on `Object.fromEntries` because a value read from JSON can carry an own
 * `__proto__` key. Writing `result[key] = value` reaches the prototype setter
 * and loses the key.
 */
export function mapValuesOrSame<T>(
  input: Record<string, T>,
  fn: (value: T, key: string) => T
): Record<string, T> {
  const entries = Object.entries(input);
  const mapped = entries.map(([key, value]): [string, T] => [
    key,
    fn(value, key),
  ]);

  if (mapped.every(([, value], index) => value === entries[index][1])) {
    return input;
  }

  return Object.fromEntries(mapped);
}
