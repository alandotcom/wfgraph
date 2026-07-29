/**
 * What an action offers downstream, read off the schema of what it returns.
 *
 * The editor's template autocomplete needs a flat list of paths a user can drop
 * into a config field. That list used to be written out by hand beside the
 * implementation, where nothing tied the two together: a forgotten entry
 * silently degraded to no autocomplete, and a path that no longer existed
 * produced a template variable resolving to nothing at run time. Reading it off
 * the schema the handler is typed against removes the gap by construction.
 *
 * Only the top level is walked. A nested object contributes its own path and
 * not its children's, which is what the hand-written lists said too; the
 * schema-tree flattener in `node-references.ts` is the one that descends, and it
 * serves the user-authored schemas (a webhook payload, an HTTP node's output)
 * rather than these.
 */

import { Schema } from "effect";
import {
  asStandardSchema,
  readAs,
  type StandardSchema,
} from "#src/types/schema";
import {
  type ReferenceField,
  schemaFieldToReferenceField,
} from "#src/workflow/node-references";
import {
  jsonSchemaLibraryOptions,
  parseWorkflowSchemaFieldsOrJsonSchema,
  type WorkflowSchemaField,
} from "#src/workflow/schema-codec";

/**
 * What an output schema may be written in: any Standard Schema library, or a
 * bare Effect schema, which is bridged here rather than by its author.
 */
export type OutputSchema<TOutput> =
  | StandardSchema<TOutput>
  | Schema.ConstraintDecoder<TOutput>;

/**
 * The JSON Schema a schema describes itself with, output side.
 *
 * The output side is what a downstream node reads, so it is asked for first. A
 * library that cannot describe its output side -- an input-only schema, or one
 * whose morph has no JSON form -- is asked for its input side instead, and one
 * that can describe neither has nothing to derive from.
 */
function describeSchema(
  schema: StandardSchema<unknown>
): Record<string, unknown> | undefined {
  try {
    return schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });
  } catch {
    try {
      return schema["~standard"].jsonSchema.input({
        target: "draft-2020-12",
        libraryOptions: jsonSchemaLibraryOptions,
      });
    } catch {
      return undefined;
    }
  }
}

/**
 * The paths and types a schema offers, as the editor lists them.
 *
 * A schema this cannot read contributes nothing, which is what `createAction`
 * wants: an embedder registering a runtime action may hand over a schema from
 * any library and may pass an `outputFields` list of its own alongside it, so a
 * derivation that came back empty still has somewhere to fall back to. A plugin
 * action has no such fallback, and `requireOutputFieldsFromSchema` below is what
 * it registers through.
 */
export function outputFieldsFromSchema(
  schema: OutputSchema<unknown>
): ReferenceField[] {
  const jsonSchema = describeSchema(asStandardSchema(schema));
  const fields = jsonSchema
    ? parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema)
    : null;

  return fields
    ? fields.map((field) => schemaFieldToReferenceField(field))
    : [];
}

/**
 * The same list for an action that must have one, or a throw naming the action.
 *
 * A plugin's output schema is the only thing standing between a step's payload
 * and the paths the editor offers, so a schema this cannot read is a mistake in
 * the plugin rather than a list to go without. Registration is the moment to say
 * so: it happens on import, so the message reaches whoever wrote the schema
 * instead of reaching a user as autocomplete that quietly lists nothing.
 */
export function requireOutputFieldsFromSchema(
  actionId: string,
  schema: OutputSchema<unknown>
): ReferenceField[] {
  const jsonSchema = describeSchema(asStandardSchema(schema));
  const fields = jsonSchema
    ? parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema)
    : null;

  const problem = findDerivationProblem(jsonSchema, fields);
  if (problem) {
    throw new Error(
      `Action "${actionId}" cannot derive its output fields: ${problem}`
    );
  }

  return (fields ?? []).map((field) => schemaFieldToReferenceField(field));
}

/**
 * Why this schema cannot become an autocomplete list, in the words the message
 * ends with, or undefined when it can.
 */
function findDerivationProblem(
  jsonSchema: Record<string, unknown> | undefined,
  fields: WorkflowSchemaField[] | null
): string | undefined {
  if (!jsonSchema) {
    return "the schema describes itself as neither an output nor an input JSON Schema.";
  }

  const properties = readProperties(jsonSchema.properties);
  if (!(fields && properties)) {
    // An array root, a union of objects, a bare primitive. A downstream node
    // addresses an output by named path, so there is nothing for it to name.
    return "its root is not an object with named properties. A step's payload is addressed by path, so the output schema is a struct.";
  }

  const declared = Object.keys(properties);
  if (declared.length === 0) {
    return "the schema declares no properties.";
  }

  const derived = new Set(fields.map((field) => field.name));
  const dropped = declared.filter((name) => !derived.has(name));
  if (dropped.length > 0) {
    return `${dropped.join(", ")} did not survive the derivation, so the editor would offer a shorter list than the step returns.`;
  }

  const unannotated = fields
    .filter((field) => !field.description?.trim())
    .map((field) => field.name);
  if (unannotated.length > 0) {
    return `${unannotated.join(", ")} carry no description annotation. The editor shows the annotation beside the path, and the type name it falls back to tells a user nothing.`;
  }

  return undefined;
}

/** A JSON Schema document's `properties`, or undefined when it has none. */
const readProperties = readAs(Schema.Record(Schema.String, Schema.Unknown));
