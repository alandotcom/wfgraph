/**
 * The schema the browser decodes the extension catalog with.
 *
 * The document is built on the server out of typed values, so a decode failure
 * here means the two halves of one deployment disagree about the contract. That
 * is not something a per-entry salvage can repair, so the read is
 * all-or-nothing: `readExtensionCatalog` answers `undefined` and the editor keeps
 * the catalog it had.
 *
 * Every field schema is `optionalKey` rather than `optional`, because this shape
 * is only ever read from parsed JSON, which carries no `undefined`.
 */

import { Schema } from "effect";
import type {
  CredentialFieldMetadata,
  ExtensionCatalog,
} from "#src/extensions/catalog";
import type { ActionConfigField } from "#src/plugins/action-fields";
import type { ShowWhen } from "#src/types/show-when";
import { NonEmptyTrimmedString, readAs } from "#src/types/schema";
import type { ReferenceField } from "#src/graph/node-references";

const selectOptionSchema = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
});

const showWhenWireSchema: Schema.Codec<ShowWhen> = Schema.Struct({
  field: Schema.String,
  equals: Schema.String,
});

/**
 * One declarative config field, matching `ActionConfigFieldBase` in
 * `plugins/action-fields`. The field types are a closed set because the config
 * renderer switches on them: a field the renderer cannot draw is not a usable
 * field.
 *
 * The list fields are wrapped in `Schema.mutable` because that module spells them
 * as mutable arrays, and a decoded `readonly` array would not satisfy them.
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
    "key-value",
  ]),
  placeholder: Schema.optionalKey(Schema.String),
  defaultValue: Schema.optionalKey(Schema.String),
  example: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.mutable(Schema.Array(selectOptionSchema))),
  rows: Schema.optionalKey(Schema.Finite),
  min: Schema.optionalKey(Schema.Finite),
  required: Schema.optionalKey(Schema.Boolean),
  literal: Schema.optionalKey(Schema.Literal(true)),
  showWhen: Schema.optionalKey(showWhenWireSchema),
});

const actionConfigFieldGroupSchema = Schema.Struct({
  label: Schema.String,
  type: Schema.Literal("group"),
  fields: Schema.mutable(Schema.Array(actionConfigFieldBaseSchema)),
  defaultExpanded: Schema.optionalKey(Schema.Boolean),
});

// The annotation is the check: a schema admitting a field that `action-fields.ts`
// does not describe -- a type literal the config renderer cannot draw, say --
// stops compiling here.
const actionConfigFieldWireSchema: Schema.Codec<ActionConfigField> =
  Schema.Union([actionConfigFieldGroupSchema, actionConfigFieldBaseSchema]);

// The annotation above catches a member this schema describes and the type does
// not. It does not catch the reverse: a literal union narrower than the type's
// still satisfies `Schema.Codec<ReferenceField>`, and a field type left out here
// fails the whole catalog decode at run time rather than the build. The
// round-trip case in `catalog-wire.test.ts` is what holds the two in step.
const referenceFieldWireSchema: Schema.Codec<ReferenceField> = Schema.Struct({
  path: Schema.String,
  description: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(
    Schema.Literals([
      "string",
      "number",
      "boolean",
      "timestamp",
      "duration",
      "array",
      "object",
    ])
  ),
  nullable: Schema.optionalKey(Schema.Boolean),
  enumValues: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  showWhen: Schema.optionalKey(showWhenWireSchema),
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
  sideEffect: Schema.optionalKey(Schema.Boolean),
  configFields: Schema.Array(actionConfigFieldWireSchema),
  outputFields: Schema.Array(referenceFieldWireSchema),
});

// Annotated, like its neighbours above: this shape is restated from
// `catalog.ts`, and the annotation is what fails the build when the two drift.
const credentialFieldMetadataSchema: Schema.Codec<CredentialFieldMetadata> =
  Schema.Struct({
    label: Schema.String,
    type: Schema.Literals(["text", "password", "url"]),
    placeholder: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    helpLink: Schema.optionalKey(
      Schema.Struct({ text: Schema.String, url: Schema.String })
    ),
  });

const integrationMetadataSchema = Schema.Struct({
  type: NonEmptyTrimmedString,
  label: NonEmptyTrimmedString,
  description: Schema.String,
  // A record, so the credential's name is its key. JSON preserves the order the
  // integration wrote, which is the order the connection dialog asks in.
  credentialFields: Schema.Record(Schema.String, credentialFieldMetadataSchema),
  hasTest: Schema.Boolean,
});

const extensionCatalogSchema: Schema.Codec<ExtensionCatalog> = Schema.Struct({
  events: Schema.Array(eventMetadataSchema),
  actions: Schema.Array(actionMetadataSchema),
  integrations: Schema.Array(integrationMetadataSchema),
});

export const readExtensionCatalog = readAs(extensionCatalogSchema);

/**
 * The envelope `GET /api/extensions` answers, which is where the catalog sits.
 *
 * `catalog` stays `Unknown` here so that a document which does not fit is answered
 * by `readExtensionCatalog` above, which reads it all-or-nothing and lets the
 * editor say so, rather than failing this decode with nothing to report.
 *
 * The route builds the response out of typed values rather than encoding through
 * this schema, so the member is named in both places and this one is the contract
 * the browser holds.
 */
export const readExtensionsResponse = readAs(
  Schema.Struct({
    catalog: Schema.optionalKey(Schema.Unknown),
  })
);
