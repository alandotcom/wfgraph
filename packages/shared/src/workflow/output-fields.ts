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
 * The walk descends. A nested object contributes its own path and every leaf
 * beneath it, so a field asking for an id is offered `appointment.id` and not
 * only the `appointment` object it sits in. `node-references.ts` owns the
 * descent and its depth cap, so a derived schema and a user-authored one (a
 * webhook payload, an HTTP node's output) flatten by the same rules.
 */

import { Schema } from "effect";
import {
  asStandardSchema,
  readAs,
  type StandardSchema,
} from "#src/types/schema";
import {
  flattenSchemaToReferenceFields,
  type ReferenceField,
  walkSchemaFields,
} from "#src/workflow/node-references";
import {
  jsonSchemaLibraryOptions,
  parseWorkflowSchemaFieldsOrJsonSchema,
  type WorkflowSchemaField,
} from "#src/workflow/schema-codec";

/**
 * What an output schema may be written in: any Standard Schema library, or a
 * bare Effect schema, which is bridged here rather than by its author.
 *
 * `TOutput` is the decoded side, because a handler produces the decoded value and
 * the encode to JSON happens after it returns. An Event's `PayloadSchema` in
 * `@rova/core` constrains the other side for the mirror-image reason: its payload
 * arrives already encoded.
 */
export type OutputSchema<TOutput> =
  | StandardSchema<TOutput>
  | Schema.ConstraintDecoder<TOutput>;

/**
 * The JSON Schema a schema describes itself with, encoded side.
 *
 * `input()` is the encoded form, and the encoded form is what every wire the
 * editor addresses actually holds: JSONB, memoized step results, template
 * paths. Asking for `output()` reads the decoded side, where a codec's target
 * type may have no JSON form at all and renders as `{}`, silently dropping the
 * field from the derived list.
 */
function describeSchema(
  schema: StandardSchema<unknown>
): Record<string, unknown> | undefined {
  try {
    return schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });
  } catch {
    return undefined;
  }
}

/**
 * The paths and types a schema offers, as the editor lists them.
 *
 * A schema this cannot read contributes nothing, which is what `createAction`
 * wants: a host may write its action's schema in any library and may pass an
 * `outputFields` list of its own alongside it, so a derivation that came back
 * empty still has somewhere to fall back to. An integration's action has no such
 * fallback, and `requireOutputFieldsFromSchema` below is what assembly holds it
 * to.
 */
export function outputFieldsFromSchema(
  schema: OutputSchema<unknown>
): ReferenceField[] {
  const jsonSchema = describeSchema(asStandardSchema(schema));
  const fields = jsonSchema
    ? parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema)
    : null;

  return fields ? flattenSchemaToReferenceFields(fields) : [];
}

/**
 * The same list for a definition that must have one, or a throw naming it.
 *
 * A schema is the only thing standing between a payload and the paths the editor
 * offers, so a schema this cannot read is a mistake in the definition rather
 * than a list to go without. An action's output schema and an Event's payload
 * schema both come through here, which is why `subject` is a phrase rather than
 * an id: it is what the message names, so it says which kind of thing is at
 * fault, as `Action "twilio/send-sms"` or `Event "app/appointment.created"`.
 *
 * The throw lands at definition, which happens as the host's module graph loads,
 * so the message reaches whoever wrote the schema instead of reaching a user as
 * autocomplete that quietly lists nothing.
 */
export function requireOutputFieldsFromSchema(
  subject: string,
  schema: OutputSchema<unknown>
): ReferenceField[] {
  const jsonSchema = describeSchema(asStandardSchema(schema));
  const fields = jsonSchema
    ? parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema)
    : null;

  const problem = findDerivationProblem(jsonSchema, fields);
  if (problem) {
    throw new Error(
      `${subject} cannot derive the fields the editor offers: ${problem}`
    );
  }

  return flattenSchemaToReferenceFields(fields ?? []);
}

/**
 * The keys a schema insists on, as its JSON Schema names them.
 *
 * This lives beside the other reader of a schema's encoded JSON Schema so the
 * project has one answer to which side of a codec describes a value. Assembly
 * asks it of an action's input schema, to hold every key the step cannot do
 * without to a config field a builder can fill in.
 *
 * An empty list is the answer for a schema with no required keys and for one this
 * cannot read at all. The second case is already a definition failure, raised by
 * `requireOutputFieldsFromSchema` against the same action's output schema.
 */
export function requiredKeysFromSchema(
  schema: OutputSchema<unknown>
): readonly string[] {
  const required = describeSchema(asStandardSchema(schema))?.required;

  return Array.isArray(required)
    ? required.filter((key): key is string => typeof key === "string")
    : [];
}

/**
 * The sentence for the author who did annotate and is being told they did not.
 *
 * A field derivation compiles the encoded side of a schema, and `.annotate()` on
 * a codec annotates its decoded side, so an annotated codec derives as bare as an
 * unannotated one. Without this, the message reads as a bug in Rova.
 */
const CODEC_ANNOTATION_HINT =
  'A codec\'s own annotations do not reach its JSON Schema (see SCHEMA.md, "Annotating the Encoded Side of a Transformation"). Annotate the encoded side with `Schema.annotateEncoded`, or use `timestampField` / `dateField`. `Schema.Date` cannot be described at all; use `dateField` instead.';

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
    return "its root is not an object with named properties. A payload is addressed by path, so the schema is a struct.";
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

  // Every path the editor offers, nested ones included, since each one is a
  // separate line in the picker and each one needs to say what it is. A nested
  // object is offered alongside its leaves -- a template can name the whole
  // object -- so the object's own annotation is required too.
  const unannotated = walkSchemaFields(fields)
    .filter(({ field }) => !field.description?.trim())
    .map(({ path }) => path);
  if (unannotated.length > 0) {
    return `${unannotated.join(", ")} carry no description annotation. The editor shows the annotation beside the path, and the type name it falls back to tells a user nothing. ${CODEC_ANNOTATION_HINT}`;
  }

  return undefined;
}

/** A JSON Schema document's `properties`, or undefined when it has none. */
const readProperties = readAs(Schema.Record(Schema.String, Schema.Unknown));
