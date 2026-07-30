/**
 * The dot-paths a payload shape offers, as types.
 *
 * A payload is described by a schema, so the paths into it are derivable from
 * the payload type alone: an author writes `correlationPath: "appointment.id"`
 * and the compiler holds it to a path that schema declares. The Event surface
 * and the trigger registry both alias these under names of their own.
 */

import type { JsonObject } from "#src/types/json";

/**
 * A value with no paths beneath it, so a path that reaches one ends there.
 *
 * `Date` and `RegExp` are listed because a payload type is free to spell them
 * even though JSON carries neither. An array is listed because an index is not
 * a path the editor can offer.
 */
type NonTraversable =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | RegExp
  | ((...args: never[]) => unknown)
  | readonly unknown[];

/** Every dot-path into `TPayload`, descending into the objects it holds. */
export type PayloadPath<TPayload> = TPayload extends JsonObject
  ? {
      [Key in Extract<
        keyof TPayload,
        string
      >]: TPayload[Key] extends NonTraversable
        ? Key
        : TPayload[Key] extends JsonObject
          ? Key | `${Key}.${PayloadPath<TPayload[Key]>}`
          : Key;
    }[Extract<keyof TPayload, string>]
  : never;

/** What `TPath` resolves to in `TPayload`, following it one segment at a time. */
type ValueAtPath<
  TPayload,
  TPath extends string,
> = TPath extends `${infer Head}.${infer Tail}`
  ? Head extends keyof TPayload
    ? ValueAtPath<TPayload[Head], Tail>
    : never
  : TPath extends keyof TPayload
    ? TPayload[TPath]
    : never;

/**
 * The dot-paths into `TPayload` that resolve to a string.
 *
 * This is what a path naming an identifier may be -- a Correlation Path, an
 * Event Type path -- since the value it points at is compared as a string.
 */
export type StringPath<TPayload> = {
  [Path in PayloadPath<TPayload>]: Extract<
    ValueAtPath<TPayload, Path>,
    string
  > extends never
    ? never
    : Path;
}[PayloadPath<TPayload>];
