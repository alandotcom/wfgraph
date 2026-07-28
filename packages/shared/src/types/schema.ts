/**
 * The two Effect Schema helpers this project reaches for often enough that they
 * belong in one place: reading a field off a document nobody validated, and
 * handing a schema to the parts of the codebase that speak Standard Schema.
 */

import { Option, Schema } from "effect";

/**
 * The member a schema must carry to be read by `readAs`, and which nothing
 * constructs. It exists so the compiler can turn away the one schema shape this
 * helper cannot serve, naming the reason in the error it prints:
 *
 *     readAs(Schema.UndefinedOr(Schema.String));
 *     // Argument of type 'UndefinedOr<String>' is not assignable to parameter
 *     // of type 'UndefinedOr<String> & { readonly [undefinedIsNotReadable]: never; }'.
 */
declare const undefinedIsNotReadable: unique symbol;

/**
 * Reads a value that arrived from outside the program, answering `undefined`
 * when it is not what `schema` describes.
 *
 * This is the repo's replacement for Zod's `.catch(undefined)`. Effect Schema
 * has no such combinator on a struct field, and a struct is the wrong tool for
 * a hostile document anyway: `Schema.Struct` looks a key up with `Object.hasOwn`,
 * so a member an SDK error class defines as a prototype getter is invisible to
 * it, and one wrong-typed field sinks the decode of every sibling beside it.
 * Reading one leaf at a time fixes both; `getErrorMessage` in `utils.ts` walks a
 * thrown value that way and finishes each walk here.
 *
 * `undefined` is this function's answer for "not what the schema describes", so
 * a schema that admits `undefined` as a value would make a successful read
 * indistinguishable from a failed one. The parameter type turns such a schema
 * away where it is written rather than letting the collapse happen at runtime.
 */
export function readAs<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S &
    (undefined extends S["Type"]
      ? { readonly [undefinedIsNotReadable]: never }
      : unknown)
): (value: unknown) => S["Type"] | undefined {
  const decode = Schema.decodeUnknownOption(schema);
  return (value) => Option.getOrUndefined(decode(value));
}

/**
 * Gives a schema both halves of Standard Schema: `~standard.validate` and
 * `~standard.jsonSchema`.
 *
 * Effect splits what Zod and arktype hand over together. The registries want
 * both from one object -- `action-registry.ts` validates a resolved config with
 * the first and derives the action's form fields from the second -- so this is
 * the bridge every registry-facing Effect schema crosses.
 *
 * Both Effect functions assign onto the schema they are given, so the value
 * that comes back is the same object, now carrying `~standard`.
 */
export function toStandardSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
) {
  return Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));
}
