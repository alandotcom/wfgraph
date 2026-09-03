import { describe, expect, it } from "vitest";
import {
  configFieldsFromJsonSchema,
  parseWorkflowSchemaField,
  parseWorkflowSchemaFieldsOrJsonSchema,
  type WorkflowSchemaField,
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

  it("keeps a calendar date as text because it is not an instant", () => {
    const field = parseWorkflowSchemaField({
      name: "birthday",
      type: "string",
      format: "date",
    });

    expect(field).toEqual({
      name: "birthday",
      type: "string",
      description: undefined,
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
      required: ["reminderLeadTime"],
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
  it("keeps nullable numeric const unions numeric", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        priority: {
          anyOf: [{ const: 1 }, { const: 2 }, { type: "null" }],
        },
      },
    });

    expect(schema).toEqual([
      {
        name: "priority",
        type: "number",
        description: undefined,
        nullable: true,
      },
    ]);
  });

  it("parses JSON schema properties including array object items", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["id", "success", "events"],
      properties: {
        id: { type: "string" },
        success: { type: ["null", "boolean"] },
        events: {
          type: "array",
          items: {
            type: "object",
            required: ["happenedAt"],
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

  it("reads minItems off an array property", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["attendees"],
      properties: {
        attendees: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
    });

    expect(schema).toEqual([
      {
        name: "attendees",
        type: "array",
        itemType: "object",
        minItems: 1,
        fields: [
          {
            name: "name",
            type: "string",
            description: undefined,
          },
        ],
        description: undefined,
      },
    ]);
  });

  // `Schema.optionalKey` renders as a property whose name is missing from
  // `required`, with no null branch anywhere in it. Reading the keyword is the
  // only way that fact reaches the picker, where it decides both the nullable
  // badge and whether `is set` is offered on the path.
  it("marks a property the required list leaves out as nullable", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["emailId"],
      properties: {
        emailId: { type: "string" },
        templateId: { type: "string" },
      },
    });

    expect(schema).toEqual([
      { name: "emailId", type: "string", description: undefined },
      {
        name: "templateId",
        type: "string",
        description: undefined,
        nullable: true,
      },
    ]);
  });

  // JSON Schema defines an absent `required` as requiring nothing, which is the
  // same reading `configFieldsFromJsonSchema` takes of the keyword.
  it("marks every property nullable when the document lists none as required", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: { emailId: { type: "string" } },
    });

    expect(schema).toEqual([
      {
        name: "emailId",
        type: "string",
        description: undefined,
        nullable: true,
      },
    ]);
  });

  it("reads the required list of a nested object and of array items", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["click", "records"],
      properties: {
        click: {
          type: "object",
          required: ["link"],
          properties: {
            link: { type: "string" },
            userAgent: { type: "string" },
          },
        },
        records: {
          type: "array",
          items: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              ttl: { type: "string" },
            },
          },
        },
      },
    });

    expect(schema).toEqual([
      {
        name: "click",
        type: "object",
        description: undefined,
        fields: [
          { name: "link", type: "string", description: undefined },
          {
            name: "userAgent",
            type: "string",
            description: undefined,
            nullable: true,
          },
        ],
      },
      {
        name: "records",
        type: "array",
        itemType: "object",
        description: undefined,
        fields: [
          { name: "name", type: "string", description: undefined },
          {
            name: "ttl",
            type: "string",
            description: undefined,
            nullable: true,
          },
        ],
      },
    ]);
  });

  // A null branch and a missing name are two separate ways for the value to go
  // missing, and either one on its own is enough.
  it("keeps a nullable optional key nullable once", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: [],
      properties: {
        sourceId: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });

    expect(schema).toEqual([
      {
        name: "sourceId",
        type: "string",
        description: undefined,
        nullable: true,
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
      required: ["id", "notANode", "mistypedDescription"],
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
      required: ["id", "brokenObject", "brokenArray"],
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

  it("reads a bare string enum with no type as a closed string set", () => {
    // JSON Schema `enum` is valid without `type`; a homogeneous string list is
    // the instance type. arktype renders every string-literal union this way.
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["status"],
      properties: {
        status: { enum: ["X", "Y"] },
      },
    });

    expect(schema).toEqual([
      {
        name: "status",
        type: "string",
        description: undefined,
        enumValues: ["X", "Y"],
      },
    ]);
  });

  it("reads a single const with no type as a one-value string set", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["status"],
      properties: {
        status: { const: "X" },
      },
    });

    expect(schema).toEqual([
      {
        name: "status",
        type: "string",
        description: undefined,
        enumValues: ["X"],
      },
    ]);
  });

  it("reads an all-const anyOf without a null branch as a non-nullable closed set", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["status"],
      properties: {
        status: {
          anyOf: [{ const: "X" }, { const: "Y" }],
        },
      },
    });

    expect(schema).toEqual([
      {
        name: "status",
        type: "string",
        description: undefined,
        enumValues: ["X", "Y"],
      },
    ]);
  });

  it("reads typed const anyOf without a null branch as a non-nullable closed set", () => {
    // Zod's `z.union([z.literal("X"), z.literal("Y")])`: each branch carries
    // both `type` and `const`. The set is still closed and not nullable.
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["status"],
      properties: {
        status: {
          anyOf: [
            { type: "string", const: "X" },
            { type: "string", const: "Y" },
          ],
        },
      },
    });

    expect(schema).toEqual([
      {
        name: "status",
        type: "string",
        description: undefined,
        enumValues: ["X", "Y"],
      },
    ]);
  });

  it("joins anyOf of one-value string enums into a closed set", () => {
    // Effect's `Schema.Enum`: one `{ type, enum: [member] }` branch per value.
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["status"],
      properties: {
        status: {
          anyOf: [
            { type: "string", enum: ["X"], title: "X" },
            { type: "string", enum: ["Y"], title: "Y" },
          ],
        },
      },
    });

    expect(schema).toEqual([
      {
        name: "status",
        type: "string",
        description: undefined,
        enumValues: ["X", "Y"],
      },
    ]);
  });

  it("unwraps a null branch around a nested enum anyOf", () => {
    // Effect's `Schema.NullOr(Schema.Enum(...))`: the enum anyOf is itself a
    // branch beside `{ type: "null" }`.
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        status: {
          anyOf: [
            {
              anyOf: [
                { type: "string", enum: ["X"] },
                { type: "string", enum: ["Y"] },
              ],
            },
            { type: "null" },
          ],
        },
      },
    });

    expect(schema).toEqual([
      {
        name: "status",
        type: "string",
        description: undefined,
        enumValues: ["X", "Y"],
        nullable: true,
      },
    ]);
  });

  it("reads a typed string beside same-type consts as an open string", () => {
    // arktype `string.uuid`: a pattern branch plus the nil and max UUID, which
    // fail the pattern. The consts are extra values of an open type.
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["a"],
      properties: {
        a: {
          anyOf: [
            { type: "string", format: "uuid", pattern: "[\\da-f]{8}-..." },
            {
              const: "00000000-0000-0000-0000-000000000000",
              format: "uuid",
            },
            {
              const: "ffffffff-ffff-ffff-ffff-ffffffffffff",
              format: "uuid",
            },
          ],
          format: "uuid",
        },
      },
    });

    expect(schema).toEqual([
      {
        name: "a",
        type: "string",
        description: undefined,
      },
    ]);
  });

  it("drops a number beside string consts, which is no single type", () => {
    // Effect's `Schema.Number`: a number or the strings Infinity, -Infinity
    // and NaN. The editor has no type for that union, so the field is omitted.
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["id", "attendeeCount"],
      properties: {
        id: { type: "string" },
        attendeeCount: {
          anyOf: [
            { type: "number" },
            { const: "Infinity" },
            { const: "-Infinity" },
            { const: "NaN" },
          ],
        },
      },
    });

    expect(schema).toEqual([
      { name: "id", type: "string", description: undefined },
    ]);
  });

  // Resend's email tags are the case: a payload key nobody can list ahead of
  // time, which only `additionalProperties` says is there at all.
  it("reads an open record's value type off additionalProperties", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["tags"],
      properties: {
        tags: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Email tags",
        },
      },
    });

    expect(schema).toEqual([
      {
        name: "tags",
        type: "object",
        fields: [],
        description: "Email tags",
        valueType: "string",
      },
    ]);
  });

  it("keeps a closed struct closed", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["click"],
      properties: {
        click: {
          type: "object",
          required: ["link"],
          properties: { link: { type: "string" } },
          additionalProperties: false,
        },
      },
    });

    expect(schema).toEqual([
      {
        name: "click",
        type: "object",
        fields: [{ name: "link", type: "string", description: undefined }],
        description: undefined,
      },
    ]);
  });

  // A library that never writes the keyword has said nothing about extra keys,
  // and reading that silence as openness would offer a path off every object.
  it("reads a missing additionalProperties as closed", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["click"],
      properties: { click: { type: "object", properties: {} } },
    });

    expect(schema).toEqual([
      { name: "click", type: "object", fields: [], description: undefined },
    ]);
  });

  // The value type is what a condition compares against, so guessing text for a
  // record of numbers would compile a string comparison against a number.
  it("offers no value type for an opening that declares none", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: { headers: { type: "object", additionalProperties: true } },
    });

    expect(schema?.[0]?.valueType).toBeUndefined();
  });

  it("reads the value format, so a record of timestamps types as one", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      properties: {
        seenAt: {
          type: "object",
          additionalProperties: { type: "string", format: "date-time" },
        },
      },
    });

    expect(schema?.[0]?.valueType).toBe("timestamp");
  });

  // `Schema.StructWithRest` is the spelling for an output that names some keys
  // and accepts others, so both halves have to survive the read.
  it("keeps named properties beside an opening", () => {
    const schema = parseWorkflowSchemaFieldsOrJsonSchema({
      type: "object",
      required: ["result"],
      properties: {
        result: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
          additionalProperties: { type: "number" },
        },
      },
    });

    expect(schema).toEqual([
      {
        name: "result",
        type: "object",
        fields: [{ name: "id", type: "string", description: undefined }],
        description: undefined,
        valueType: "number",
      },
    ]);
  });
});

describe("workflowSchemaFieldsToJsonSchemaDocument", () => {
  // The reader concludes nullable from a name the writer left out of `required`,
  // so the two halves have to agree on the keyword or a field survives one trip
  // through the pair as something a payload can arrive without.
  it("round-trips which fields a payload is guaranteed to carry", () => {
    const fields: WorkflowSchemaField[] = [
      { name: "emailId", type: "string" },
      { name: "templateId", type: "string", nullable: true },
    ];

    expect(
      parseWorkflowSchemaFieldsOrJsonSchema(
        workflowSchemaFieldsToJsonSchemaDocument(fields)
      )
    ).toEqual([
      { name: "emailId", type: "string", description: undefined },
      {
        name: "templateId",
        type: "string",
        description: undefined,
        nullable: true,
      },
    ]);
  });

  // The reader answers `format` and `additionalProperties` from whether the
  // document wrote the key at all, and `configFieldsFromJsonSchema` reads this
  // record back in process, so a key present and holding undefined would read
  // as a keyword the field had declared.
  it("writes no format or additionalProperties key for a field that declares neither", () => {
    const document = workflowSchemaFieldsToJsonSchemaDocument([
      { name: "subject", type: "string" },
      {
        name: "meta",
        type: "object",
        fields: [{ name: "id", type: "string" }],
      },
      { name: "labels", type: "array", itemType: "string" },
    ]);

    expect(document).toStrictEqual({
      type: "object",
      properties: {
        subject: { type: "string" },
        meta: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["subject", "meta", "labels"],
    });
  });

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
            required: ["name"],
          },
        },
      },
      required: ["createdAt", "items"],
    });
  });

  it("serializes open object value types through additionalProperties", () => {
    const document = workflowSchemaFieldsToJsonSchemaDocument([
      {
        name: "labels",
        type: "object",
        valueType: "string",
        fields: [
          { name: "source", type: "string" },
          { name: "note", type: "string", nullable: true },
        ],
      },
      {
        name: "countsById",
        type: "object",
        valueType: "number",
      },
      {
        name: "flagsById",
        type: "object",
        valueType: "boolean",
      },
      {
        name: "seenAtById",
        type: "object",
        valueType: "timestamp",
      },
      {
        name: "ttlById",
        type: "object",
        valueType: "duration",
      },
      {
        name: "metadataById",
        type: "object",
        valueType: "object",
      },
    ]);

    expect(document).toEqual({
      type: "object",
      properties: {
        labels: {
          type: "object",
          properties: {
            source: { type: "string" },
            note: { type: "string" },
          },
          required: ["source"],
          additionalProperties: { type: "string" },
        },
        countsById: {
          type: "object",
          properties: {},
          additionalProperties: { type: "number" },
        },
        flagsById: {
          type: "object",
          properties: {},
          additionalProperties: { type: "boolean" },
        },
        seenAtById: {
          type: "object",
          properties: {},
          additionalProperties: { type: "string", format: "date-time" },
        },
        ttlById: {
          type: "object",
          properties: {},
          additionalProperties: { type: "string", format: "duration" },
        },
        metadataById: {
          type: "object",
          properties: {},
          additionalProperties: { type: "object" },
        },
      },
      required: [
        "labels",
        "countsById",
        "flagsById",
        "seenAtById",
        "ttlById",
        "metadataById",
      ],
    });
  });

  // A cyclic in-memory document overflows the stack inside readJsonSchemaNode
  // before any later walk can depth-cap it. None of the schema libraries emit
  // one, but a hand-built document must return a bounded read rather than throw.
  it("returns a bounded read for a cyclic in-memory JSON Schema document", () => {
    const document: Record<string, unknown> = {
      type: "object",
      required: ["id", "self"],
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
      required: ["nested"],
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

  it("maps const unions to select fields", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      required: ["choice"],
      properties: {
        choice: {
          anyOf: [{ const: "alpha" }, { const: "beta" }],
          description: "Choice",
        },
      },
    });

    expect(fields).toEqual([
      {
        key: "choice",
        label: "Choice",
        type: "select",
        options: [
          { value: "alpha", label: "alpha" },
          { value: "beta", label: "beta" },
        ],
        required: true,
      },
    ]);
  });

  it("maps a closed set inside a nullable union to a select field", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      properties: {
        choice: {
          anyOf: [
            {
              anyOf: [
                { type: "string", enum: ["alpha"] },
                { type: "string", enum: ["beta"] },
              ],
            },
            { type: "null" },
          ],
          description: "Choice",
        },
      },
    });

    expect(fields).toEqual([
      {
        key: "choice",
        label: "Choice",
        type: "select",
        options: [
          { value: "alpha", label: "alpha" },
          { value: "beta", label: "beta" },
        ],
      },
    ]);
  });

  it("keeps a typed branch beside same-type consts as an open field", () => {
    const fields = configFieldsFromJsonSchema({
      type: "object",
      properties: {
        id: {
          anyOf: [
            { type: "string", format: "uuid", pattern: "[\\da-f]{8}-..." },
            { const: "00000000-0000-0000-0000-000000000000" },
            { const: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
          ],
        },
      },
    });

    expect(fields).toEqual([
      { key: "id", label: "Id", type: "template-input" },
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
