import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { type } from "arktype";
import { z } from "zod";
import { toStandardSchema } from "#src/types/schema";
import { createAction } from "./action-registry";
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
 * Effect splits Standard Schema across two functions, so the registries only
 * see a schema that has been through `toStandardSchema`. These cases are the
 * proof that what comes out the far side is the same kind of object the Zod and
 * arktype arms above hand over.
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

  it("validates synchronously, as the action registry requires", () => {
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

describe("createAction with Effect schemas", () => {
  it("derives configFields from an Effect input schema", () => {
    const action = createAction({
      id: "effect/input-test",
      label: "Effect Input Test",
      description: "Tests Effect input schema derivation",
      schema: toStandardSchema(
        Schema.Struct({
          name: Schema.String.annotate({ description: "Full name" }),
          // `Schema.Finite`, not `Schema.Number`: Effect renders an unbounded
          // number as an `anyOf` that also admits "Infinity" and "NaN" strings,
          // and the field reader sees no single type in that.
          count: Schema.Finite,
          tone: Schema.Literals(["warm", "cool"]),
          note: Schema.optionalKey(Schema.String),
        })
      ),
      execute({ payload }) {
        return { success: true, data: { echo: payload.name } };
      },
    });

    expect(action.configFields).toEqual([
      {
        key: "name",
        label: "Full name",
        type: "template-input",
        required: true,
      },
      { key: "count", label: "Count", type: "number", required: true },
      {
        key: "tone",
        label: "Tone",
        type: "select",
        required: true,
        options: [
          { value: "warm", label: "warm" },
          { value: "cool", label: "cool" },
        ],
      },
      { key: "note", label: "Note", type: "template-input" },
    ]);
  });

  it("derives outputFields from an Effect output schema", () => {
    const action = createAction({
      id: "effect/output-test",
      label: "Effect Output Test",
      description: "Tests Effect output schema derivation",
      schema: toStandardSchema(Schema.Struct({ id: Schema.String })),
      outputSchema: toStandardSchema(
        Schema.Struct({
          name: Schema.String,
          nickname: Schema.NullOr(Schema.String),
        })
      ),
      execute() {
        return { success: true, data: { name: "Test", nickname: null } };
      },
    });

    const fields = action.outputFields ?? [];
    expect(fields.find((f) => f.path === "name")?.type).toBe("string");
    expect(fields.find((f) => f.path === "nickname")?.type).toBe("string");
    expect(fields.find((f) => f.path === "nickname")?.nullable).toBe(true);
  });

  it("validates the payload before execute sees it", async () => {
    const action = createAction({
      id: "effect/validate-test",
      label: "Effect Validate",
      description: "Tests Effect validation",
      schema: toStandardSchema(
        Schema.Struct({ text: Schema.String.check(Schema.isMinLength(1)) })
      ),
      execute({ payload }) {
        return { success: true, data: { echo: payload.text } };
      },
    });

    const context = {
      nodeId: "n1",
      nodeName: "Test",
      nodeType: "effect/validate-test",
    };

    expect(
      (await action.execute({ payload: { text: "hello" }, context })).success
    ).toBe(true);
    expect(
      (await action.execute({ payload: { text: "" }, context })).success
    ).toBe(false);
  });

  it("surfaces an Effect pattern field as a timestamp through allOf", () => {
    // Effect hangs every check-derived keyword off `allOf`, so the `pattern`
    // that names a timestamp sits one level below where arktype and Zod write
    // it. `parseWorkflowSchemaFieldsOrJsonSchema` looks through `allOf`, which
    // is what puts this arm level with the other two.
    const schema = toStandardSchema(
      Schema.Struct({
        createdAt: Schema.String.check(
          Schema.isPattern(new RegExp(ISO_DATE_PATTERN))
        ),
      })
    );
    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });

    expect(parseWorkflowSchemaFieldsOrJsonSchema(jsonSchema)).toEqual([
      { name: "createdAt", type: "timestamp", description: undefined },
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

describe("parseWorkflowSchemaFieldsOrJsonSchema with ISO date patterns", () => {
  it("recognizes ISO date pattern as timestamp", () => {
    const fields = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        nextEligibleDate: { type: "string", pattern: ISO_DATE_PATTERN },
      },
    });

    expect(fields).toEqual([
      { name: "nextEligibleDate", type: "timestamp", description: undefined },
    ]);
  });

  it("recognizes nullable ISO date pattern as nullable timestamp", () => {
    const fields = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        dateOfBirth: {
          anyOf: [
            { type: "string", pattern: ISO_DATE_PATTERN },
            { type: "null" },
          ],
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

describe("createAction with Arktype schemas", () => {
  it("derives configFields from Arktype input schema", () => {
    const action = createAction({
      id: "arktype/input-test",
      label: "Arktype Input Test",
      description: "Tests Arktype input schema derivation",
      schema: type({
        name: "string",
        count: "number",
      }),
      execute() {
        return { success: true };
      },
    });

    const fields = action.configFields ?? [];
    expect(fields.length).toBe(2);

    const nameField = fields.find((f) => "key" in f && f.key === "name");
    expect(nameField).toBeDefined();
    expect(nameField && "type" in nameField ? nameField.type : undefined).toBe(
      "template-input"
    );

    const countField = fields.find((f) => "key" in f && f.key === "count");
    expect(countField).toBeDefined();
    expect(
      countField && "type" in countField ? countField.type : undefined
    ).toBe("number");
  });

  it("derives outputFields from Arktype output schema with date morphs", () => {
    const action = createAction({
      id: "arktype/output-date-test",
      label: "Arktype Output Date Test",
      description: "Tests Arktype output schema with date.parse",
      schema: type({ id: "string" }),
      outputSchema: type({
        name: "string",
        createdAt: "string.date.iso.parse",
      }),
      execute() {
        return {
          success: true,
          data: { name: "Test", createdAt: new Date() },
        };
      },
    });

    const fields = action.outputFields ?? [];
    expect(fields.length).toBe(2);

    const nameField = fields.find((f) => f.path === "name");
    expect(nameField).toBeDefined();
    expect(nameField?.type).toBe("string");

    const createdAtField = fields.find((f) => f.path === "createdAt");
    expect(createdAtField).toBeDefined();
    expect(createdAtField?.type).toBe("timestamp");
    expect(createdAtField?.format).toBe("timestamp");
  });

  it("does not crash when Arktype output schema has predicate types", () => {
    const action = createAction({
      id: "arktype/predicate-test",
      label: "Arktype Predicate Test",
      description: "Tests Arktype output schema with predicate",
      schema: type({ id: "string" }),
      outputSchema: type({
        dateStr: "string.date",
        name: "string",
      }),
      execute() {
        return {
          success: true,
          data: { dateStr: "2026-01-01", name: "Test" },
        };
      },
    });

    const fields = action.outputFields ?? [];
    expect(fields.length).toBe(2);
    expect(fields.find((f) => f.path === "name")?.type).toBe("string");
    expect(fields.find((f) => f.path === "dateStr")?.type).toBe("string");
  });

  it("derives outputFields from Arktype output schema with nullable fields", () => {
    const action = createAction({
      id: "arktype/nullable-output-test",
      label: "Arktype Nullable Output Test",
      description: "Tests that nullable fields appear in outputFields",
      schema: type({ donorUuid: "string" }),
      outputSchema: type({
        uuid: "string",
        firstName: "string",
        "middleInitial?": "string | null",
        email: "string",
        "phone?": "string | null",
        dateOfBirth: "string.date.iso | null",
        bloodType: "'A' | 'B' | 'AB' | 'O' | null",
        hasPermanentDeferral: "boolean",
        createdAt: "string.date.iso",
      }),
      execute() {
        return { success: true, data: {} as Record<string, unknown> };
      },
    });

    const fields = action.outputFields ?? [];
    const fieldNames = fields.map((f) => f.path).sort();

    expect(fieldNames).toContain("uuid");
    expect(fieldNames).toContain("firstName");
    expect(fieldNames).toContain("middleInitial");
    expect(fieldNames).toContain("email");
    expect(fieldNames).toContain("phone");
    expect(fieldNames).toContain("dateOfBirth");
    expect(fieldNames).toContain("bloodType");
    expect(fieldNames).toContain("hasPermanentDeferral");
    expect(fieldNames).toContain("createdAt");
    expect(fields).toHaveLength(9);

    // string.date.iso fields should be detected as timestamps via pattern
    expect(fields.find((f) => f.path === "dateOfBirth")?.type).toBe(
      "timestamp"
    );
    expect(fields.find((f) => f.path === "createdAt")?.type).toBe("timestamp");
  });

  it("validates payload with Arktype schema", async () => {
    const action = createAction({
      id: "arktype/validate-test",
      label: "Arktype Validate",
      description: "Tests Arktype validation",
      schema: type({
        text: "string > 0",
      }),
      execute({ payload }) {
        return { success: true, data: { echo: payload.text } };
      },
    });

    const successResult = await action.execute({
      payload: { text: "hello" },
      context: {
        nodeId: "n1",
        nodeName: "Test",
        nodeType: "arktype/validate-test",
      },
    });
    expect(successResult.success).toBe(true);

    const failResult = await action.execute({
      payload: { text: "" },
      context: {
        nodeId: "n1",
        nodeName: "Test",
        nodeType: "arktype/validate-test",
      },
    });
    expect(failResult.success).toBe(false);
  });
});
