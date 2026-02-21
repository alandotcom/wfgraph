import { describe, expect, it } from "bun:test";
import {
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
