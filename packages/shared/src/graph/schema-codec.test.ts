import { describe, expect, it } from "vitest";
import {
  configFieldsFromJsonSchema,
  parseWorkflowSchemaField,
  parseWorkflowSchemaFieldsOrJsonSchema,
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

  it("normalizes a primitive duration field", () => {
    // `format: "duration"` is JSON Schema's own keyword for an ISO 8601 length
    // of time, which is what an author declares a wait's input with.
    const field = parseWorkflowSchemaField({
      name: "reminderLeadTime",
      type: "string",
      format: "duration",
      description: "How long before the appointment",
    });

    expect(field).toEqual({
      name: "reminderLeadTime",
      type: "duration",
      description: "How long before the appointment",
    });
  });

  it("writes a duration field back as the format it was read from", () => {
    expect(
      workflowSchemaFieldsToJsonSchemaDocument([
        {
          name: "reminderLeadTime",
          type: "duration",
          description: "How long before the appointment",
        },
      ])
    ).toEqual({
      type: "object",
      properties: {
        reminderLeadTime: {
          type: "string",
          format: "duration",
          description: "How long before the appointment",
        },
      },
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

  it("treats a mistyped itemType as absent, leaving a plain string field", () => {
    // Only a named item type makes a field an array. A number in `itemType`
    // names nothing, so the field falls back to the default type.
    expect(parseWorkflowSchemaField({ name: "tags", itemType: 5 })).toEqual({
      name: "tags",
      type: "string",
      description: undefined,
    });
  });

  it("still reads an unrecognized item type name as an array of strings", () => {
    expect(
      parseWorkflowSchemaField({ name: "tags", itemType: "bogus" })
    ).toEqual({
      name: "tags",
      type: "array",
      itemType: "string",
      fields: undefined,
      description: undefined,
    });
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

  it("drops one malformed property and still reads the rest of the document", () => {
    // A saved schema with one broken member has to stay readable, otherwise the
    // whole schema panel empties over a single bad field.
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        id: { type: "string" },
        notANode: "nope",
        mistypedDescription: { type: "number", description: 7 },
      },
    });

    expect(schema).toEqual([
      { name: "id", type: "string", description: undefined },
      { name: "mistypedDescription", type: "number", description: undefined },
    ]);
  });

  it("drops a property whose only type evidence is an unusable properties or items", () => {
    // `properties: "nope"` is no object map and `items: "nope"` is no node, so
    // neither says what the field holds and neither field is offered.
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        id: { type: "string" },
        brokenObject: { properties: "nope" },
        brokenArray: { items: "nope" },
      },
    });

    expect(schema).toEqual([
      { name: "id", type: "string", description: undefined },
    ]);
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

  // A cyclic in-memory document overflows the stack inside readJsonSchemaNode
  // before any later walk can depth-cap it. None of the schema libraries emit
  // one, but a hand-built document must return a bounded read rather than throw.
  it("returns a bounded read for a cyclic in-memory JSON Schema document", () => {
    const document: Record<string, unknown> = {
      type: "object",
      properties: {
        id: { type: "string" },
      },
    };
    (document.properties as Record<string, unknown>).self = document;

    expect(() => parseWorkflowSchemaFieldsOrJsonSchema(document)).not.toThrow();

    expect(parseWorkflowSchemaFieldsOrJsonSchema(document)).toEqual([
      {
        name: "id",
        type: "string",
        description: undefined,
      },
    ]);
  });

  it("returns a bounded read when items points at its own parent node", () => {
    const items: Record<string, unknown> = { type: "object", properties: {} };
    items.items = items;
    const document = {
      type: "object",
      properties: {
        nested: {
          type: "array",
          items,
        },
      },
    };

    expect(() => parseWorkflowSchemaFieldsOrJsonSchema(document)).not.toThrow();

    expect(parseWorkflowSchemaFieldsOrJsonSchema(document)).toEqual([
      {
        name: "nested",
        type: "array",
        itemType: "object",
        fields: [],
        description: undefined,
      },
    ]);
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

  it("ignores a required list that is not all field names", () => {
    // `required` is a list of property names. A member that is not a name makes
    // the list unreadable, and both arktype and zod emit string arrays, so a
    // mixed list means the document was hand-edited and is not trusted.
    const fields = configFieldsFromJsonSchema({
      type: "object",
      required: ["email", 7],
      properties: {
        email: { type: "string", description: "Email" },
      },
    });

    expect(fields[0]?.required).toBeUndefined();
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

  it("renders a structured example as its JSON text, the way a default is rendered", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      properties: {
        payload: {
          type: "string",
          description: "Payload",
          examples: [{ deep: 1 }],
        },
      },
    });

    expect(fields[0]?.example).toBe('{"deep":1}');
  });

  it("returns empty array for schema without properties", () => {
    expect(configFieldsFromJsonSchema({})).toEqual([]);
    expect(configFieldsFromJsonSchema({ type: "object" })).toEqual([]);
  });
});
