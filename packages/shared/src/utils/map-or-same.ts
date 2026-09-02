/**
 * Map an array or a record, answering the input itself when every element
 * mapped to itself. A caller reconciling during render reads that returned
 * reference as "nothing changed" and writes no state, so a reconcile that
 * repaired nothing does not look like an edit.
 */

/**
 * The mapped array, or `items` itself when `fn` answered every element with the
 * element it was given. The array type is carried through, so a mutable array
 * maps to a mutable array and a `readonly` one stays `readonly`.
 */
export function mapOrSame<Items extends readonly unknown[]>(
  items: Items,
  fn: (item: Items[number], index: number) => Items[number]
): Items {
  const next = items.map((item, index) => fn(item, index));

  if (next.every((item, index) => item === items[index])) {
    return items;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the mapped array holds the element type Items was written with, which is what makes it an Items; the compiler stops at `Items[number][]` because a type parameter could also name a tuple.
  return next as unknown as Items;
}

/**
 * The record with every value mapped, or `input` itself when `fn` answered
 * every value with the value it was given. Key order follows the input.
 *
 * Built on `Object.fromEntries` because a value read from JSON can carry an own
 * `__proto__` key: writing `result[key] = value` would reach the prototype
 * setter and lose the key.
 */
export function mapValuesOrSame<T extends object>(
  input: T,
  fn: (value: T[keyof T], key: keyof T) => T[keyof T]
): T {
  const entries = objectEntries(input);
  const mapped = entries.map(
    ([key, value]) => [key, fn(value, key)] as [string, T[keyof T]]
  );

  if (mapped.every(([, value], index) => value === entries[index][1])) {
    return input;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every key of T is present holding a T[keyof T], which Object.fromEntries reports as an open record rather than as T.
  return Object.fromEntries(mapped) as T;
}

/** `Object.entries` with the value type of `T` kept, which the standard signature widens to `any`. */
function objectEntries<T extends object>(
  input: T
): Array<[keyof T & string, T[keyof T]]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an own enumerable key of T is a `keyof T & string` holding a T[keyof T]; the standard signature answers `any` for the value.
  return Object.entries(input) as Array<[keyof T & string, T[keyof T]]>;
}
