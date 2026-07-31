/**
 * The Effect Schema helpers this project reaches for often enough that they
 * belong in one place: reading a field off a document nobody validated, the one
 * string shape half the contracts are built from, the decode options the strict
 * schemas are read with, the two object shapes every wire schema is built from,
 * reading the field names a schema of any library declares, and handing a schema
 * to the parts of the codebase that speak Standard Schema.
 */

import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import { Option, Schema, type SchemaAST, SchemaTransformation } from "effect";

/**
 * A string that carries something once its surrounding whitespace is gone.
 *
 * Every identifier crossing the wire is this: a workflow id, a node key, an
 * integration id, the token on a resume URL. The trim is a decode step rather
 * than a rejection, which is what Zod's `.trim().min(1)` did and what the JSON
 * Schema now says out loud -- the encoded side accepts any string, the decoded
 * side is the one with a length floor.
 */
export const NonEmptyTrimmedString = Schema.String.pipe(
  Schema.decodeTo(Schema.String, SchemaTransformation.trim())
).check(Schema.isMinLength(1));

/**
 * How every schema in this project reads a document that came from outside it.
 *
 * Effect has no per-schema equivalent of Zod's `.strict()`: a closed object is
 * closed because the decode was told to close it, so an object schema read
 * without this option silently accepts whatever else the payload carried. The
 * options travel two ways -- handed to a decode call directly, or closed over by
 * `toStandardSchema` for the consumers that call `~standard.validate` with
 * nothing else to say.
 *
 * An object that is meant to stay open says so in its own shape, with
 * `Schema.StructWithRest`. An index signature skips the excess-property check
 * entirely, so such a schema stays open under these options.
 */
export const rejectUnknownKeys: SchemaAST.ParseOptions = {
  onExcessProperty: "error",
};

/**
 * Anything else the payload carried, kept as it arrived.
 *
 * The rest half of a `Schema.StructWithRest`, which is how a shape that is meant
 * to stay open says so: an index signature skips the excess-property check, so
 * such a schema stays open even when the decode carries `rejectUnknownKeys`.
 */
export const unknownRest = [
  Schema.Record(Schema.String, Schema.Unknown),
] as const;

/**
 * A list, in the form both ends of the wire already hold it.
 *
 * `Schema.Array` describes a `readonly T[]`, which is the right default for a
 * schema and the wrong one for a payload: the server hands back an array it
 * just built and the client sorts and filters what it receives, so a readonly
 * element type would push a copy into every one of those call sites for a
 * guarantee neither side wanted.
 */
export function listOf<S extends Schema.ConstraintDecoder<unknown>>(item: S) {
  return Schema.mutable(Schema.Array(item));
}

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
 * Whether a schema has already been across the bridge below.
 *
 * `~standard` alone is not the answer: Effect's two bridge functions write into
 * the same object, so a schema can carry a `jsonSchema` and still be waiting for
 * the `validate` that parse options ride on.
 */
function hasStandardValidate(schema: object): boolean {
  if (!("~standard" in schema)) {
    return false;
  }

  const standard: unknown = schema["~standard"];
  return (
    typeof standard === "object" &&
    standard !== null &&
    "validate" in standard &&
    typeof standard.validate === "function"
  );
}

/**
 * Gives a schema both halves of Standard Schema: `~standard.validate` and
 * `~standard.jsonSchema`.
 *
 * Effect splits what Zod and arktype hand over together. The registries want
 * both from one object -- `defineAction` validates a resolved config with
 * the first and derives the action's form fields from the second -- so this is
 * the bridge every registry-facing Effect schema crosses.
 *
 * `parseOptions` is how a schema carries decode behaviour across that bridge.
 * Effect treats those options as an argument to a decode, but a Standard Schema
 * consumer calls `~standard.validate(value)` with nothing else to say, so every
 * option would be lost at the boundary: oRPC validates an RPC payload that way,
 * and Inngest validates an event payload that way. Passing them here closes
 * them over inside the `validate` this builds, which is what lets a schema stay
 * strict about unknown keys once it leaves this module. Effect has no
 * per-schema equivalent of Zod's `.strict()`, so
 * `{ onExcessProperty: "error" }` given here is the whole mechanism.
 *
 * Both Effect functions assign onto the schema they are given, so the value
 * that comes back is the same object, now carrying `~standard`. That also means
 * the first call wins: a schema that already has a `validate` keeps it, options
 * and all, so a schema wanting these options has to cross this bridge once.
 *
 * A second crossing with options is therefore a silent loss, and which crossing
 * came first is decided by module initialisation order -- nothing a reader of
 * either call site can see. So the second crossing throws instead.
 */
export function toStandardSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  parseOptions?: SchemaAST.ParseOptions
) {
  if (parseOptions && hasStandardValidate(schema)) {
    throw new Error(
      "This schema already carries a Standard Schema validate, so these parse options would be silently dropped. Which crossing ran first is decided by module initialisation order, which no call site can see, so a schema that needs parse options must cross this bridge exactly once."
    );
  }

  return Schema.toStandardJSONSchemaV1(
    Schema.toStandardSchemaV1(schema, { parseOptions })
  );
}

/**
 * The top-level field names a schema declares, read off the object the schema
 * library exposes rather than off its JSON Schema.
 *
 * None of the three property names is Standard Schema, which is why this answers
 * `undefined` rather than throwing for a library that publishes none of them --
 * a caller treats that as "no names known" and leaves a CEL expression or a
 * reference list as it found it.
 *
 * Three names, because two libraries and two Effect shapes. Zod calls it
 * `shape`; `Schema.Struct` calls it `fields`; `Schema.StructWithRest` -- the
 * shape an open payload schema has -- carries neither, and exposes the struct it
 * wraps as `schema`, whose own `fields` are the names wanted here. Each check
 * falls through rather than answering, because a property being present says
 * nothing about it holding an object of field names: a payload schema is free to
 * declare a field literally called `shape`.
 */
export function extractSchemaKeys(schema: unknown): string[] | undefined {
  // An Effect schema is callable, so `typeof` answers "function" for every one
  // of them. Testing for an object alone would put both Effect branches below
  // out of reach.
  if (
    (typeof schema !== "object" && typeof schema !== "function") ||
    schema === null
  ) {
    return undefined;
  }

  if ("shape" in schema) {
    const names = fieldNamesOf(schema.shape);
    if (names) {
      return names;
    }
  }

  if ("fields" in schema) {
    const names = fieldNamesOf(schema.fields);
    if (names) {
      return names;
    }
  }

  return "schema" in schema ? extractSchemaKeys(schema.schema) : undefined;
}

/** The keys of a field container, or `undefined` if it is not one. */
function fieldNamesOf(declared: unknown): string[] | undefined {
  return typeof declared === "object" && declared !== null
    ? Object.keys(declared)
    : undefined;
}

/**
 * A schema that both validates and describes itself, which is what the trigger
 * and action registries need from one object: the first checks a payload, the
 * second is where the editor's form fields and reference paths come from.
 *
 * Zod and arktype hand over an object of this shape already.
 */
export type StandardSchema<T> = StandardSchemaV1<unknown, T> &
  StandardJSONSchemaV1<unknown, T>;

/**
 * `Schema.isSchema` under a signature that keeps the payload type.
 *
 * The guard Effect exports answers `Top`, which loses the `T` the caller is
 * holding: the bridge below would be left with a schema of no particular
 * payload, and a decode built from one would ask for services no schema needs.
 *
 * `REncode` is what a caller that means to encode through the schema has to say.
 * The default is `ConstraintDecoder`'s open encode-direction service parameter,
 * which `encodeUnknownResult` refuses; every Effect schema carries both
 * directions at run time, so `isEffectSchema<T, never>` is how a caller states
 * the half it is holding. Neither parameter is a finding of the check, which
 * cannot tell one payload type from another. Exported because the intake gate
 * and `defineAction`'s encoder pick their path on this same question.
 */
export function isEffectSchema<T, REncode = unknown>(
  schema: unknown
): schema is Schema.ConstraintCodec<T, unknown, never, REncode> {
  return Schema.isSchema(schema);
}

/**
 * `defineAction` and `defineEvent`'s one-line rule for the schema an author
 * handed them: bridge it if it is an Effect schema, take it as it is otherwise.
 *
 * This exists so that writing an Event's payload or an action's schema in
 * Effect Schema reads the same as writing one in Zod -- `schema:
 * Schema.Struct({ ... })`, no wrapper -- while the library-agnostic seam stays
 * exactly as wide as it was. Definition is where it is called, which is the one
 * moment a schema is handled before anything reads it, so the bridge's
 * first-call-wins rule is satisfied by there being only one call.
 *
 * `Other` is whatever the caller's own seam already accepted, handed back
 * untouched. `defineEvent` names one shape there, its payload; `defineAction`
 * names two, its input and its output, and neither has to restate this bridge
 * to say so.
 *
 * The discrimination is exact rather than structural: `Schema.isSchema` tests
 * for the `"~effect/Schema/Schema"` type id Effect brands every schema with, so
 * no amount of resemblance makes a Zod or arktype schema answer to it. The
 * bridge is idempotent besides -- Effect returns a schema that already carries a
 * `validate` untouched -- so an author who bridged by hand loses nothing here.
 */
export function asStandardSchema<T, Other>(
  schema: Other | Schema.ConstraintDecoder<T>
): Other | StandardSchema<T> {
  return isEffectSchema<T>(schema) ? toStandardSchema(schema) : schema;
}
