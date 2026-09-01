import { defineMeta, oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { Schema } from "effect";
import {
  NonEmptyTrimmedString,
  rejectUnknownKeys,
  toStandardSchema,
  unknownRest,
} from "#src/types/schema";
import type { WfGraphOperation } from "#src/authorization/operations";

/** oRPC metadata that the server middleware reads before a business handler runs. */
export const [wfGraphOperationMeta, getWfGraphOperation] = defineMeta(
  "wfgraph.operation",
  (incoming: WfGraphOperation) => incoming
);

/**
 * Declares a procedure's REST shape. Routing metadata moved off the contract
 * builder in oRPC 2, and this helper is the single line coupling the contracts
 * to @orpc/openapi.
 */
export function route(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: `/${string}`,
  operation: WfGraphOperation
) {
  return oc.meta(
    wfGraphOperationMeta(operation),
    openapi({
      method,
      path,
      operationId: operation.id,
      spec: (current) => ({
        ...current,
        "x-wfgraph-permission": operation.permission,
      }),
    })
  );
}

/**
 * Hands a schema to oRPC as a Standard Schema, closed to keys it did not name.
 *
 * `@orpc/experimental-effect` exports a `toStandardSchema` of its own and this
 * is not it. That one takes no parse options, and parse options are the only
 * way an Effect schema can be strict about unknown keys: oRPC calls
 * `~standard.validate(payload)` with nothing else to say, so anything the
 * schema wants to be true of that call has to be closed over before it gets
 * there. The two are otherwise interchangeable -- Effect assigns `~standard`
 * onto the schema and hands the same object back, so the schema oRPC holds is
 * still an Effect schema either way, which is what
 * `EffectSchemaToJsonSchemaConverter` looks for when it builds the OpenAPI
 * document. The one thing oRPC's version adds, carrying meta plugins across, is
 * a copy onto the object it was read from.
 *
 * Effect's bridge is first-call-wins: a schema that already carries a
 * `validate` keeps it, options and all. So every schema crosses here exactly
 * once. A shape more than one procedure names is bridged once at module scope
 * and the binding is what the procedures hand to oRPC. `toStandardSchema`
 * throws on a second crossing that carries options rather than dropping them,
 * so this is a rule the contracts cannot quietly break.
 */
export function contractSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
) {
  return toStandardSchema(schema, rejectUnknownKeys);
}

/**
 * A procedure that takes no arguments still declares the empty object.
 *
 * Open rather than closed, and not for taste: `Schema.Struct({})` describes
 * TypeScript's `object`, so its JSON Schema is `anyOf: [object, array]` and
 * oRPC refuses it for a GET, whose inputs are query parameters and must be an
 * object. Naming the rest gives the plain `{"type":"object"}` the generator
 * wants. It also lets a stray query parameter through instead of answering 400,
 * which is what a GET taking no arguments should do with a cache-buster.
 */
export const noInput = contractSchema(
  Schema.StructWithRest(Schema.Struct({}), unknownRest)
);

export const deleted = contractSchema(
  Schema.Struct({ success: Schema.Literal(true) })
);

export const idSchema = NonEmptyTrimmedString;
