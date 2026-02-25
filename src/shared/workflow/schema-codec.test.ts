import { describe, expect, it } from "bun:test";
import {
  configFieldsFromJsonSchema,
  parseWorkflowSchemaField,
  parseWorkflowSchemaFieldsOrJsonSchema,
  parseWorkflowSchemaFieldsString,
  workflowSchemaFieldsToJsonSchemaDocument,
} from "./schema-codec";

describe("parseWorkflowSchemaField", () => {
  it("normalizes primitive timestamp fields", () => {
    const field = parseWorkflowSchemaField({
      name: " createdAt ",
      type: "string",
      format: "date-time",
      description: "Created timestamp",
    });

    expect(field).toEqual({
      name: "createdAt",
      type: "timestamp",
      description: "Created timestamp",
    });
  });

  it("parses array object fields and drops invalid nested entries", () => {
    const field = parseWorkflowSchemaField({
      name: "events",
      type: "array",
      itemType: "object",
      fields: [
        { name: "eventType", type: "string" },
        { name: "  ", type: "string" },
      ],
    });

    expect(field).toEqual({
      name: "events",
      type: "array",
      itemType: "object",
      fields: [
        {
          name: "eventType",
          type: "string",
          description: undefined,
        },
      ],
      description: undefined,
    });
  });
});

describe("parseWorkflowSchemaFieldsString", () => {
  it("returns empty schema for invalid JSON", () => {
    expect(parseWorkflowSchemaFieldsString("{not-json")).toEqual([]);
  });
});

describe("parseWorkflowSchemaFieldsOrJsonSchema", () => {
  it("parses JSON schema properties including array object items", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        id: { type: "string" },
        success: { type: ["null", "boolean"] },
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              happenedAt: {
                type: "string",
                format: "datetime",
              },
            },
          },
        },
      },
    });

    expect(schema).toEqual([
      {
        name: "id",
        type: "string",
        description: undefined,
      },
      {
        name: "success",
        type: "boolean",
        description: undefined,
      },
      {
        name: "events",
        type: "array",
        itemType: "object",
        fields: [
          {
            name: "happenedAt",
            type: "timestamp",
            description: undefined,
          },
        ],
        description: undefined,
      },
    ]);
  });

  it("returns null for unsupported non-object schema roots", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "array",
      items: { type: "string" },
    });

    expect(schema).toBeNull();
  });
});

describe("workflowSchemaFieldsToJsonSchemaDocument", () => {
  it("serializes workflow schema fields into JSON schema format", () => {
    const document = workflowSchemaFieldsToJsonSchemaDocument([
      {
        name: "createdAt",
        type: "timestamp",
        description: "Event creation time",
      },
      {
        name: "items",
        type: "array",
        itemType: "object",
        fields: [
          {
            name: "name",
            type: "string",
          },
        ],
      },
    ]);

    expect(document).toEqual({
      type: "object",
      properties: {
        createdAt: {
          type: "string",
          format: "date-time",
          description: "Event creation time",
        },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
              },
            },
          },
        },
      },
    });
  });
});

describe("configFieldsFromJsonSchema", () => {
  it("maps string properties to template-input", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      properties: {
        name: { type: "string", description: "Full Name" },
      },
    });

    expect(fields).toEqual([
      { key: "name", label: "Full Name", type: "template-input" },
    ]);
  });

  it("maps number properties with minimum to number fields", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      properties: {
        count: { type: "number", description: "Item Count", minimum: 0 },
      },
    });

    expect(fields).toEqual([
      { key: "count", label: "Item Count", type: "number", min: 0 },
    ]);
  });

  it("maps integer properties to number fields", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      properties: {
        retries: { type: "integer", description: "Retry Count" },
      },
    });

    expect(fields).toEqual([
      { key: "retries", label: "Retry Count", type: "number" },
    ]);
  });

  it("maps boolean properties to select with Yes/No options", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      properties: {
        active: { type: "boolean", description: "Is Active" },
      },
    });

    expect(fields).toEqual([
      {
        key: "active",
        label: "Is Active",
        type: "select",
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
      },
    ]);
  });

  it("maps enum properties to select with options", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["active", "inactive"],
          description: "Status",
        },
      },
    });

    expect(fields).toEqual([
      {
        key: "status",
        label: "Status",
        type: "select",
        options: [
          { value: "active", label: "active" },
          { value: "inactive", label: "inactive" },
        ],
      },
    ]);
  });

  it("maps object properties to key-value", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      properties: {
        headers: { type: "object", description: "HTTP Headers" },
      },
    });

    expect(fields).toEqual([
      { key: "headers", label: "HTTP Headers", type: "key-value" },
    ]);
  });

  it("uses startCase(key) as label when description is missing", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      properties: {
        appointmentId: { type: "string" },
      },
    });

    expect(fields[0]?.label).toBe("Appointment Id");
  });

  it("sets required on fields listed in the required array", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string", description: "Email" },
        phone: { type: "string", description: "Phone" },
      },
    });

    expect(fields.find((f) => f.key === "email")?.required).toBe(true);
    expect(fields.find((f) => f.key === "phone")?.required).toBeUndefined();
  });

  it("maps default values to defaultValue as string", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      properties: {
        retries: { type: "number", description: "Retries", default: 3 },
      },
    });

    expect(fields[0]?.defaultValue).toBe("3");
  });

  it("maps examples[0] to example as string", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Webhook URL",
          examples: ["https://example.com/webhook"],
        },
      },
    });

    expect(fields[0]?.example).toBe("https://example.com/webhook");
  });

  it("returns empty array for schema without properties", () => {
    expect(configFieldsFromJsonSchema({})).toEqual([]);
    expect(configFieldsFromJsonSchema({ type: "object" })).toEqual([]);
  });
});
