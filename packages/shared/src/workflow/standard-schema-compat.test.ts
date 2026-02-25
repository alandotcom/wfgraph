import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { z } from "zod";
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

  it("handles string.date.iso without morph (stays as string)", () => {
    const schema = type({ isoDate: "string.date.iso" });
    const jsonSchema = schema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
      libraryOptions: jsonSchemaLibraryOptions,
    });

    const props = jsonSchema.properties as Record<string, unknown>;
    const isoDate = props.isoDate as Record<string, unknown>;
    expect(isoDate.type).toBe("string");
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

    const nameField = fields.find((f) => f.field === "name");
    expect(nameField).toBeDefined();
    expect(nameField?.type).toBe("string");

    const createdAtField = fields.find((f) => f.field === "createdAt");
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
    expect(fields.find((f) => f.field === "name")?.type).toBe("string");
    expect(fields.find((f) => f.field === "dateStr")?.type).toBe("string");
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
    const fieldNames = fields.map((f) => f.field).sort();

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
