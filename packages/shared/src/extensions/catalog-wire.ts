/**
 * The schema the browser decodes the extension catalog with.
 *
 * The document is built on the server out of typed values, so a decode failure
 * here means the two halves of one deployment disagree about the contract. That
 * is not something a per-entry salvage can repair, so the read is
 * all-or-nothing: `readExtensionCatalog` answers `undefined` and the editor
 * keeps the empty catalog.
 *
 * Every field schema is `optionalKey` rather than `optional`, because this shape
 * is only ever read from parsed JSON, which carries no `undefined`.
 */

import { Schema } from "effect";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import type { ActionConfigField } from "#src/plugins/registry";
import { NonEmptyTrimmedString, readAs } from "#src/types/schema";
import type { ReferenceField } from "#src/workflow/node-references";

const selectOptionSchema = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
});

/**
 * One declarative config field, matching `ActionConfigFieldBase` in the plugin
 * registry. The field types are a closed set because the config renderer
 * switches on them: a field the renderer cannot draw is not a usable field.
 *
 * The list fields are wrapped in `Schema.mutable` because the registry's own
 * types spell them as mutable arrays, and a decoded `readonly` array would not
 * satisfy them.
 */
const actionConfigFieldBaseSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  type: Schema.Literals([
    "template-input",
    "template-textarea",
    "text",
    "number",
    "select",
    "schema-builder",
    "key-value",
  ]),
  placeholder: Schema.optionalKey(Schema.String),
  defaultValue: Schema.optionalKey(Schema.String),
  example: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.mutable(Schema.Array(selectOptionSchema))),
  rows: Schema.optionalKey(Schema.Finite),
  min: Schema.optionalKey(Schema.Finite),
  required: Schema.optionalKey(Schema.Boolean),
  showWhen: Schema.optionalKey(
    Schema.Struct({
      field: Schema.String,
      equals: Schema.String,
    })
  ),
});

const actionConfigFieldGroupSchema = Schema.Struct({
  label: Schema.String,
  type: Schema.Literal("group"),
  fields: Schema.mutable(Schema.Array(actionConfigFieldBaseSchema)),
  defaultExpanded: Schema.optionalKey(Schema.Boolean),
});

// The annotation is the check: a schema that admits a field the registry's own
// contract does not have -- a type literal the config renderer cannot draw, say
// -- stops compiling here.
export const actionConfigFieldWireSchema: Schema.Codec<ActionConfigField> =
  Schema.Union([actionConfigFieldGroupSchema, actionConfigFieldBaseSchema]);

export const referenceFieldWireSchema: Schema.Codec<ReferenceField> =
  Schema.Struct({
    path: Schema.String,
    description: Schema.String,
    type: Schema.optionalKey(
      Schema.Literals([
        "string",
        "number",
        "boolean",
        "timestamp",
        "array",
        "object",
      ])
    ),
    format: Schema.optionalKey(Schema.Literal("timestamp")),
    nullable: Schema.optionalKey(Schema.Boolean),
    enumValues: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  });

const eventMetadataSchema = Schema.Struct({
  name: NonEmptyTrimmedString,
  label: NonEmptyTrimmedString,
  description: Schema.optionalKey(Schema.String),
  correlationPath: Schema.optionalKey(Schema.String),
  payloadFields: Schema.Array(referenceFieldWireSchema),
});

const actionMetadataSchema = Schema.Struct({
  // The selector keys on id and shows label, so both must carry a value.
  id: NonEmptyTrimmedString,
  label: NonEmptyTrimmedString,
  description: Schema.String,
  category: Schema.String,
  integration: Schema.optionalKey(Schema.String),
  logoUrl: Schema.optionalKey(Schema.String),
  configFields: Schema.Array(actionConfigFieldWireSchema),
  outputFields: Schema.Array(referenceFieldWireSchema),
});

const credentialFieldMetadataSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  type: Schema.Literals(["text", "password", "url"]),
  placeholder: Schema.optionalKey(Schema.String),
  helpText: Schema.optionalKey(Schema.String),
  helpLink: Schema.optionalKey(
    Schema.Struct({ text: Schema.String, url: Schema.String })
  ),
  configKey: Schema.String,
  envVar: Schema.optionalKey(Schema.String),
});

const integrationMetadataSchema = Schema.Struct({
  type: NonEmptyTrimmedString,
  label: NonEmptyTrimmedString,
  description: Schema.String,
  credentialFields: Schema.Array(credentialFieldMetadataSchema),
  hasTest: Schema.Boolean,
});

export const extensionCatalogSchema: Schema.Codec<ExtensionCatalog> =
  Schema.Struct({
    events: Schema.Array(eventMetadataSchema),
    actions: Schema.Array(actionMetadataSchema),
    integrations: Schema.Array(integrationMetadataSchema),
  });

export const readExtensionCatalog = readAs(extensionCatalogSchema);
