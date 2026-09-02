/**
 * Drops every key whose value is `undefined` and keeps every other value,
 * including `null`, `""`, `0` and `false`. Built on `Object.entries` and
 * `Object.fromEntries` because a wire payload can carry an own `__proto__` key:
 * writing `result[key] = value` would reach the prototype setter and lose it.
 */

/** The keys of `T` whose declared type admits `undefined`. */
type UndefinedKeys<T> = {
  [Key in keyof T]-?: undefined extends T[Key] ? Key : never;
}[keyof T];

/** Collapses an intersection into one object type, keeping optional markers. */
type Flatten<T> = { [Key in keyof T]: T[Key] };

/**
 * The result type: a key that could hold `undefined` becomes optional with
 * `undefined` taken out of its type, and every other key stays as it was. A
 * type with a string index signature has no separable optional keys, so its
 * values lose `undefined` in place. That case turns a `JsonObjectDraft` into a
 * `JsonObject`.
 */
export type OmitUndefined<T> = string extends keyof T
  ? { [Key in keyof T]: Exclude<T[Key], undefined> }
  : Flatten<
      { [Key in Exclude<keyof T, UndefinedKeys<T>>]: T[Key] } & {
        [Key in UndefinedKeys<T>]?: Exclude<T[Key], undefined>;
      }
    >;

export function omitUndefined<T extends object>(input: T): OmitUndefined<T> {
  const present = Object.entries(input).filter(
    ([, value]) => value !== undefined
  );

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries answers an open record, and the compiler cannot follow the key-by-key reasoning OmitUndefined<T> states through a runtime filter.
  return Object.fromEntries(present) as OmitUndefined<T>;
}
