import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { type } from "arktype";
import { z } from "zod";
import { extractSchemaKeys, toStandardSchema } from "#src/types/schema";
import { requireOutputFieldsFromSchema } from "#src/graph/output-fields";
import { rewriteCelExpression } from "#src/lifecycle/inngest-event-data";
import {
  jsonSchemaLibraryOptions,
  parseWorkflowSchemaFieldsOrJsonSchema,
} from "./schema-codec";

describe("jsonSchemaLibraryOptions with Arktype", () => {
  it("handles string.date.iso.parse via date fallback", () => {
    const schema = type({ createdAt: "string.date.iso.parse" });
    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema.type).toBe("object");
    const props = jsonSchema.properties as Record<string, unknown>;
    const createdAt = props.createdAt as Record<string, unknown>;
    expect(createdAt.type).toBe("string");
    expect(createdAt.format).toBe("date-time");
  });

  it("handles string.date.parse via date fallback", () => {
    const schema = type({ updatedAt: "string.date.parse" });
    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });

    const props = jsonSchema.properties as Record<string, unknown>;
    const updatedAt = props.updatedAt as Record<string, unknown>;
    expect(updatedAt.type).toBe("string");
    expect(updatedAt.format).toBe("date-time");
  });

  it("handles string.date (predicate) via predicate fallback", () => {
    const schema = type({ dateStr: "string.date" });
    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });

    const props = jsonSchema.properties as Record<string, unknown>;
    const dateStr = props.dateStr as Record<string, unknown>;
    expect(dateStr.type).toBe("string");
  });

  it("handles string.date.iso with pattern detection", () => {
    const schema = type({ isoDate: "string.date.iso" });
    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });

    const props = jsonSchema.properties as Record<string, unknown>;
    const isoDate = props.isoDate as Record<string, unknown>;
    expect(isoDate.type).toBe("string");
    expect(typeof isoDate.pattern).toBe("string");
  });

  it("handles mixed schema with dates and plain fields", () => {
    const schema = type({
      id: "string",
      name: "string",
      createdAt: "string.date.iso.parse",
      count: "number",
    });

    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });

    const props = jsonSchema.properties as Record<string, unknown>;
    expect((props.id as Record<string, unknown>).type).toBe("string");
    expect((props.name as Record<string, unknown>).type).toBe("string");
    expect((props.count as Record<string, unknown>).type).toBe("number");
    expect((props.createdAt as Record<string, unknown>).type).toBe("string");
    expect((props.createdAt as Record<string, unknown>).format).toBe(
      "date-time"
    );
  });
});

describe("jsonSchemaLibraryOptions with Zod", () => {
  it("handles z.iso.datetime() natively without fallbacks", () => {
    const schema = z.object({ createdAt: z.iso.datetime() });
    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });

    const props = jsonSchema.properties as Record<string, unknown>;
    const createdAt = props.createdAt as Record<string, unknown>;
    expect(createdAt.type).toBe("string");
    expect(createdAt.format).toBe("date-time");
  });

  it("ignores libraryOptions without error", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });

    expect(jsonSchema.type).toBe("object");
    const props = jsonSchema.properties as Record<string, unknown>;
    expect((props.name as Record<string, unknown>).type).toBe("string");
    expect((props.age as Record<string, unknown>).type).toBe("number");
  });
});

/**
 * Effect splits Standard Schema across two functions, so a reader only ever
 * sees a schema that has been through `toStandardSchema`. These cases are the
 * proof that what comes out the far side is the same kind of object the Zod and
 * arktype arms above hand over. `defineEvent` and `defineAction` call it
 * themselves, where the definition is written; the RPC contracts and the Inngest
 * event types call it directly, because they need it to carry parse options.
 */
describe("toStandardSchema with Effect Schema", () => {
  it("carries both halves of Standard Schema on one object", () => {
    const schema = toStandardSchema(
      Schema.Struct({ name: Schema.String, count: Schema.Finite })
    );

    expect(schema["~standard"].vendor).toBe("effect");
    expect(typeof schema["~standard"].validate).toBe("function");
    expect(typeof schema["~standard"].jsonSchema.input).toBe("function");
    expect(typeof schema["~standard"].jsonSchema.output).toBe("function");
  });

  it("validates synchronously, as a resolved config decode requires", () => {
    const schema = toStandardSchema(Schema.Struct({ text: Schema.String }));

    const ok = schema["~standard"].validate({ text: "hello" });
    expect(ok).not.toBeInstanceOf(Promise);
    expect("value" in ok && ok.value).toEqual({ text: "hello" });

    const bad = schema["~standard"].validate({ text: 7 });
    expect("issues" in bad && bad.issues?.length).toBeGreaterThan(0);
  });

  it("bakes parse options into validate, where a consumer cannot pass any", () => {
    // The reason `toStandardSchema` takes parse options at all. oRPC and
    // Inngest both validate a payload by calling `~standard.validate(value)`,
    // with nowhere to say `onExcessProperty`, so a schema that has to reject an
    // unknown key has to carry that decision with it. Effect has no per-schema
    // `.strict()`; this is the whole mechanism.
    const fields = { triggerType: Schema.Literal("Webhook") };

    const strict = toStandardSchema(Schema.Struct(fields), {
      onExcessProperty: "error",
    });
    const strictResult = strict["~standard"].validate({
      triggerType: "Webhook",
      integrationId: "stray",
    });
    expect("issues" in strictResult && strictResult.issues?.length).toBe(1);

    // Without the option the same stray key is dropped and the value passes,
    // which is what every schema that does not ask for strictness still wants.
    const open = toStandardSchema(Schema.Struct(fields));
    const openResult = open["~standard"].validate({
      triggerType: "Webhook",
      integrationId: "stray",
    });
    expect("value" in openResult && openResult.value).toEqual({
      triggerType: "Webhook",
    });
  });

  it("refuses a second crossing that carries parse options", () => {
    // Effect's bridge is first-call-wins, so a second set of options is
    // dropped in silence, and which crossing ran first is decided by module
    // initialisation order. A schema that has to be strict cannot be left
    // depending on that, so the second crossing is an error instead.
    const schema = Schema.Struct({ triggerType: Schema.Literal("Webhook") });
    toStandardSchema(schema, { onExcessProperty: "error" });

    expect(() =>
      toStandardSchema(schema, { onExcessProperty: "error" })
    ).toThrow(/already carries a Standard Schema validate/);
  });

  it("lets a second crossing without options through, as Effect does", () => {
    // No options means nothing to lose, and Effect already treats this as the
    // no-op it is: the same object comes back, validate and all.
    const schema = Schema.Struct({ text: Schema.String });
    const first = toStandardSchema(schema);

    expect(toStandardSchema(schema)).toBe(first);
  });

  it("keeps an annotated description at the top of the derived JSON Schema", () => {
    // `annotate` before `check`, not after: a check applied last nests the
    // description inside `allOf`, where the field-label reader cannot see it.
    const schema = toStandardSchema(
      Schema.Struct({
        text: Schema.String.annotate({ description: "Message text" }).check(
          Schema.isMinLength(1)
        ),
      })
    );

    const jsonSchema = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    const props = jsonSchema.properties as Record<string, unknown>;
    expect((props.text as Record<string, unknown>).description).toBe(
      "Message text"
    );
  });
});

/**
 * What this package derives from a bridged schema, whichever library wrote it.
 * The bridge itself belongs to whoever calls it, so `defineAction`'s own cases
 * live in `packages/core` beside that function.
 */
describe("the derivations over a bridged schema", () => {
  it("reads the field names of an open Effect payload schema", () => {
    // A payload that admits keys it did not name is a `Schema.StructWithRest`,
    // which carries neither Zod's `shape` nor `Schema.Struct`'s `fields`: the
    // struct it wraps is under `schema`. Those names are what a `priority.run`
    // expression is checked against, so reading them is the difference between a
    // typo being caught where it was written and being sent to Inngest.
    const schema = Schema.StructWithRest(
      Schema.Struct({ event: Schema.String, entityId: Schema.String }),
      [Schema.Record(Schema.String, Schema.String)]
    );

    expect(
      rewriteCelExpression(
        "entityId == 'x' ? 100 : 0",
        extractSchemaKeys(schema)
      )
    ).toBe("event.data.entityId == 'x' ? 100 : 0");

    expect(() =>
      rewriteCelExpression(
        "entitId == 'x' ? 100 : 0",
        extractSchemaKeys(schema)
      )
    ).toThrow('Invalid identifier "entitId"');
  });

  it("reads an action's output schema down to the picker's list", () => {
    // The other half of the same seam. An integration's action declares its output
    // as a schema and assembly derives what the editor's autocomplete offers, so
    // this is that derivation over the shapes a schema library gives it. The
    // description an annotation carries is the field's description; `annotate` goes
    // before `check`, or the check owns it and nests it out of the reader's sight.
    const output = Schema.Struct({
      sid: Schema.String.annotate({ description: "Message SID" }).check(
        Schema.isMinLength(1)
      ),
      attempts: Schema.Number.annotate({
        description: "Send attempts",
      }).check(Schema.isFinite()),
      failedAt: Schema.NullOr(
        Schema.String.annotate({ description: "When the send failed" })
      ),
    });

    expect(
      requireOutputFieldsFromSchema('Action "twilio/compat-send"', output)
    ).toEqual([
      { path: "sid", description: "Message SID", type: "string" },
      { path: "attempts", description: "Send attempts", type: "number" },
      {
        path: "failedAt",
        description: "When the send failed",
        type: "string",
        nullable: true,
      },
    ]);
  });

  it("reads a nested output schema down to its leaves", () => {
    // What a step returns is rarely flat, and a config field asking for an id
    // needs the leaf that holds one. The object keeps its own entry beside the
    // leaves, because a template can name a whole object and the engine renders
    // it as JSON.
    const output = Schema.Struct({
      message: Schema.Struct({
        sid: Schema.String.annotate({ description: "Message SID" }),
        to: Schema.Struct({
          number: Schema.String.annotate({
            description: "Recipient number",
          }),
        }).annotate({ description: "Who it went to" }),
      }).annotate({ description: "The message that was sent" }),
      // No named properties, so there is no leaf under it to offer.
      metadata: Schema.Record(Schema.String, Schema.String).annotate({
        description: "Whatever the account attaches",
      }),
    });

    expect(
      requireOutputFieldsFromSchema('Action "twilio/compat-nested"', output)
    ).toEqual([
      {
        path: "message",
        description: "The message that was sent",
        type: "object",
      },
      { path: "message.sid", description: "Message SID", type: "string" },
      {
        path: "message.to",
        description: "Who it went to",
        type: "object",
      },
      {
        path: "message.to.number",
        description: "Recipient number",
        type: "string",
      },
      {
        path: "metadata",
        description: "Whatever the account attaches",
        type: "object",
      },
    ]);
  });

  // A schema that describes the action while offering the editor nothing it can
  // address. This used to be silent: the derivation answered an empty list, and
  // an action with no autocomplete looks the same to a user as one whose fields
  // have not loaded yet.
  it("refuses an output schema the editor cannot address by path", () => {
    expect(() =>
      requireOutputFieldsFromSchema(
        'Action "twilio/compat-array"',
        Schema.Array(Schema.String.annotate({ description: "Message SID" }))
      )
    ).toThrow(/"twilio\/compat-array".+root is not an object/);
  });

  it("carries a description only where the author wrote one, at any depth", () => {
    // A description is decoration a host adds where the key reads badly, and it
    // travels with the path it was written on: an object's own words describe
    // the object, and a leaf inside it stays as bare as it was declared.
    expect(
      requireOutputFieldsFromSchema(
        'Action "twilio/compat-bare"',
        Schema.Struct({
          status: Schema.String,
          message: Schema.Struct({ sentAt: Schema.String }).annotate({
            description: "The message that was sent",
          }),
        })
      )
    ).toStrictEqual([
      { path: "status", type: "string" },
      {
        path: "message",
        description: "The message that was sent",
        type: "object",
      },
      { path: "message.sentAt", type: "string" },
    ]);
  });

  // A field whose JSON Schema this reader cannot use disappears from the list
  // rather than failing, so the count is what catches it. `Schema.Number`
  // describes itself as a number or one of the strings "Infinity", "-Infinity"
  // and "NaN", which is a union the reader has no single type for; a finite
  // check is what makes it the plain number the editor can offer.
  it("refuses an output schema whose fields do not all survive the read", () => {
    expect(() =>
      requireOutputFieldsFromSchema(
        'Action "twilio/compat-dropped"',
        Schema.Struct({
          sid: Schema.String.annotate({ description: "Message SID" }),
          attempts: Schema.Number.annotate({
            description: "Send attempts",
          }),
        })
      )
    ).toThrow(/"twilio\/compat-dropped".+attempts did not survive/);
  });
});

/**
 * What an Effect schema describes itself as, once it has crossed the bridge.
 * These reach for `toStandardSchema` directly, because what they assert is the
 * JSON Schema Effect derives rather than what a caller does with it.
 */
describe("the field derivation over Effect schemas", () => {
  it("surfaces a hand-annotated Effect string as a described timestamp", () => {
    // Effect derives no `format` for any of its date schemas, so an Effect author
    // writes the keyword themselves. It goes on the base type, before any check:
    // annotations on a checked schema land on the check, which renders under
    // `allOf`, and the derivation reads the flat property.
    const schema = toStandardSchema(
      Schema.Struct({
        createdAt: Schema.String.annotate({
          description: "When it was created",
          format: "date-time",
        }).check(Schema.isPattern(/Z$/)),
      })
    );
    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });

    expect(parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema)).toEqual([
      {
        name: "createdAt",
        type: "timestamp",
        description: "When it was created",
      },
    ]);
  });

  it("reads the keyword through Effect's own optional rendering", () => {
    // `Schema.optional` renders as `anyOf: [T, null]`, so the keyword sits on a
    // member rather than on the property. Deriving from the schema itself is the
    // point: the hand-written document beside this one would keep passing if
    // Effect moved where it puts the keyword.
    expect(
      requireOutputFieldsFromSchema(
        "Probe",
        Schema.Struct({
          startsAt: Schema.optional(
            Schema.String.annotate({
              description: "When it starts",
              format: "date-time",
            })
          ),
        })
      )
    ).toEqual([
      {
        path: "startsAt",
        description: "When it starts",
        type: "timestamp",
        format: "timestamp",
        nullable: true,
      },
    ]);
  });

  it("looks through allOf for the keyword a check contributed", () => {
    // A schema library is free to hang the keyword one level down, and Effect
    // hangs everything a `.check(...)` contributed there. The walk into `allOf`
    // is what keeps such a document readable.
    expect(
      parseWorkflowSchemaFieldsOrJsonSchema({
        type: "object",
        properties: {
          createdAt: {
            type: "string",
            description: "When it was created",
            allOf: [{ format: "date-time" }],
          },
        },
      })
    ).toEqual([
      {
        name: "createdAt",
        type: "timestamp",
        description: "When it was created",
      },
    ]);
  });

  it("leaves an Effect date morph as a plain string", () => {
    // Not an `allOf` problem: Effect derives neither `format` nor `pattern` for
    // `DateFromString`, so its JSON Schema is a bare `{ type: "string" }` and
    // there is no keyword anywhere in it to recognise. An Effect schema that
    // wants its dates read as timestamps has to carry the pattern itself, as
    // the case above does.
    const schema = toStandardSchema(
      Schema.Struct({ createdAt: Schema.DateFromString })
    );
    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });

    expect(parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema)).toEqual([
      { name: "createdAt", type: "string", description: undefined },
    ]);
  });
});

describe("parseWorkflowSchemaFieldsOrJsonSchema with date formats", () => {
  it("recognizes format: date-time as timestamp", () => {
    const fields = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        createdAt: { type: "string", format: "date-time" },
      },
    });

    expect(fields).toEqual([
      { name: "createdAt", type: "timestamp", description: undefined },
    ]);
  });

  it("recognizes format: date as timestamp", () => {
    const fields = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        birthday: { type: "string", format: "date" },
      },
    });

    expect(fields).toEqual([
      { name: "birthday", type: "timestamp", description: undefined },
    ]);
  });
});

const ISO_DATE_PATTERN =
  "^([+-]?\\d{4}(?!\\d{2}\\b))((-?)((0[1-9]|1[0-2])(\\3([12]\\d|0[1-9]|3[01]))?|W([0-4]\\d|5[0-3])(-?[1-7])?|(00[1-9]|0[1-9]\\d|[12]\\d{2}|3([0-5]\\d|6[1-6])))(T((([01]\\d|2[0-3])((:?)[0-5]\\d)?|24:?00)([,.]\\d+(?!:))?)?(\\17[0-5]\\d([,.]\\d+)?)?([Zz]|([+-])([01]\\d|2[0-3]):?([0-5]\\d)?)?)?)?$";

describe("parseWorkflowSchemaFieldsOrJsonSchema and the format keyword", () => {
  it("reads a string carrying only an ISO pattern as text", () => {
    // A `format` keyword is the only evidence a field names a moment in time.
    // Recognising a regex instead meant recognising one library's spelling of it
    // by its opening characters, and an author had no way to ask for the type.
    const fields = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        nextEligibleDate: { type: "string", pattern: ISO_DATE_PATTERN },
      },
    });

    expect(fields).toEqual([
      { name: "nextEligibleDate", type: "string", description: undefined },
    ]);
  });

  it("carries format through the nullable unwrap", () => {
    // What an optional field renders as: `anyOf: [T, null]`. The keyword sits on
    // the member rather than on the property, so reading the member is what makes
    // an optional timestamp field a timestamp.
    const fields = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        dateOfBirth: {
          anyOf: [
            { type: "string", format: "date-time", description: "Born" },
            { type: "null" },
          ],
        },
      },
    });

    expect(fields).toEqual([
      {
        name: "dateOfBirth",
        type: "timestamp",
        description: "Born",
        nullable: true,
      },
    ]);
  });
});

describe("parseWorkflowSchemaFieldsOrJsonSchema with nullable types", () => {
  it("handles anyOf with null branch (string | null)", () => {
    const fields = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        middleInitial: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
    });

    expect(fields).toEqual([
      {
        name: "middleInitial",
        type: "string",
        description: undefined,
        nullable: true,
      },
    ]);
  });

  it("handles anyOf with null branch and format (date | null)", () => {
    const fields = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        dateOfBirth: {
          anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
      },
    });

    expect(fields).toEqual([
      {
        name: "dateOfBirth",
        type: "timestamp",
        description: undefined,
        nullable: true,
      },
    ]);
  });

  it("handles anyOf with const branches and null (enum | null)", () => {
    const fields = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        bloodType: {
          anyOf: [
            { const: "A" },
            { const: "B" },
            { const: "AB" },
            { type: "null" },
          ],
        },
      },
    });

    expect(fields).toEqual([
      {
        name: "bloodType",
        type: "string",
        description: undefined,
        enumValues: ["A", "B", "AB"],
        nullable: true,
      },
    ]);
  });

  it("handles oneOf with null branch", () => {
    const fields = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        phone: {
          oneOf: [{ type: "string" }, { type: "null" }],
        },
      },
    });

    expect(fields).toEqual([
      {
        name: "phone",
        type: "string",
        description: undefined,
        nullable: true,
      },
    ]);
  });

  it("preserves non-nullable fields alongside nullable ones", () => {
    const fields = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        uuid: { type: "string" },
        middleInitial: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        hasPermanentDeferral: { type: "boolean" },
      },
    });

    expect(fields).toHaveLength(3);
    expect(fields?.find((f) => f.name === "uuid")?.type).toBe("string");
    expect(fields?.find((f) => f.name === "middleInitial")?.type).toBe(
      "string"
    );
    expect(fields?.find((f) => f.name === "hasPermanentDeferral")?.type).toBe(
      "boolean"
    );
  });
});
