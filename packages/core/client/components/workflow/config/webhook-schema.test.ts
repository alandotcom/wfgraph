import { describe, expect, it } from "bun:test";
import { getValueByPath } from "@/shared/utils/object-path";
import {
  flattenSchemaPathOptions,
  inferPrimitiveType,
  inferSchemaField,
  inferSchemaFromPayload,
  isIso8601Timestamp,
  isSchemaEditorMode,
  parseSchemaJsonEdit,
  readConfigString,
  readSchemaFromConfigKey,
  readWebhookOutputSchema,
  readWebhookRequestSchema,
  webhookOutputSchemaPatch,
  webhookRequestSchemaPatch,
  webhookSchemaPatchFromSamplePayload,
} from "./webhook-schema";

describe("isIso8601Timestamp", () => {
  it("accepts the timestamp shapes webhook payloads actually carry", () => {
    expect(isIso8601Timestamp("2026-02-11T18:00:00Z")).toBe(true);
    expect(isIso8601Timestamp("2026-02-12T15:00:00-05:00")).toBe(true);
    expect(isIso8601Timestamp("2026-02-12T15:00:00.123Z")).toBe(true);
    expect(isIso8601Timestamp("  2026-02-11T18:00:00Z  ")).toBe(true);
  });

  it("rejects anything that is not a full offset-bearing timestamp", () => {
    expect(isIso8601Timestamp("")).toBe(false);
    expect(isIso8601Timestamp("2026-02-11")).toBe(false);
    expect(isIso8601Timestamp("2026-02-11T18:00:00")).toBe(false);
    expect(isIso8601Timestamp("appt_123")).toBe(false);
  });

  it("rejects a well-formed string that is not a real instant", () => {
    expect(isIso8601Timestamp("2026-13-45T99:00:00Z")).toBe(false);
  });
});

describe("inferPrimitiveType", () => {
  it("maps a JSON scalar to the schema type the builder offers", () => {
    expect(inferPrimitiveType(42)).toBe("number");
    expect(inferPrimitiveType(false)).toBe("boolean");
    expect(inferPrimitiveType("2026-02-11T18:00:00Z")).toBe("timestamp");
    expect(inferPrimitiveType("scheduled")).toBe("string");
  });

  it("falls back to string for values with no schema counterpart", () => {
    expect(inferPrimitiveType(null)).toBe("string");
    expect(inferPrimitiveType(undefined)).toBe("string");
  });
});

describe("inferSchemaField", () => {
  it("describes an array of objects by its first element", () => {
    expect(
      inferSchemaField("items", [{ sku: "S1", qty: 2 }, { sku: "S2" }])
    ).toEqual({
      name: "items",
      type: "array",
      itemType: "object",
      fields: [
        { name: "sku", type: "string" },
        { name: "qty", type: "number" },
      ],
    });
  });

  it("describes an array of primitives by its element type", () => {
    expect(inferSchemaField("tags", ["red", "blue"])).toEqual({
      name: "tags",
      type: "array",
      itemType: "string",
    });
  });

  it("treats an empty array as an array of strings", () => {
    expect(inferSchemaField("tags", [])).toEqual({
      name: "tags",
      type: "array",
      itemType: "string",
    });
  });

  it("descends into a nested object", () => {
    expect(inferSchemaField("data", { id: "appt_1", paid: true })).toEqual({
      name: "data",
      type: "object",
      fields: [
        { name: "id", type: "string" },
        { name: "paid", type: "boolean" },
      ],
    });
  });
});

describe("inferSchemaFromPayload", () => {
  it("turns a webhook payload into the schema a user would have typed", () => {
    expect(
      inferSchemaFromPayload({
        type: "appointment.create",
        timestamp: "2026-02-11T18:00:00Z",
        data: {
          id: "appt_123",
          startsAt: "2026-02-12T15:00:00-05:00",
          status: "scheduled",
        },
      })
    ).toEqual([
      { name: "type", type: "string" },
      { name: "timestamp", type: "timestamp" },
      {
        name: "data",
        type: "object",
        fields: [
          { name: "id", type: "string" },
          { name: "startsAt", type: "timestamp" },
          { name: "status", type: "string" },
        ],
      },
    ]);
  });

  it("returns nothing for an empty payload", () => {
    expect(inferSchemaFromPayload({})).toEqual([]);
  });
});

describe("flattenSchemaPathOptions", () => {
  it("offers a container alongside every leaf inside it", () => {
    expect(
      flattenSchemaPathOptions([
        { name: "type", type: "string" },
        {
          name: "data",
          type: "object",
          fields: [{ name: "id", type: "string" }],
        },
      ])
    ).toEqual([
      { path: "type", type: "string" },
      { path: "data", type: "object" },
      { path: "data.id", type: "string" },
    ]);
  });

  it("addresses array elements by numeric segment, not by bracket", () => {
    expect(
      flattenSchemaPathOptions([
        {
          name: "items",
          type: "array",
          itemType: "object",
          fields: [{ name: "sku", type: "string" }],
        },
      ])
    ).toEqual([
      { path: "items", type: "array" },
      { path: "items.0.sku", type: "string" },
    ]);
  });

  it("stops at an array of primitives, which has no child to name", () => {
    expect(
      flattenSchemaPathOptions([
        { name: "tags", type: "array", itemType: "string" },
      ])
    ).toEqual([{ path: "tags", type: "array" }]);
  });

  it("skips fields whose name is blank", () => {
    expect(
      flattenSchemaPathOptions([
        { name: "   ", type: "string" },
        { name: "ok", type: "string" },
      ])
    ).toEqual([{ path: "ok", type: "string" }]);
  });

  it("emits paths that routing can actually read back off the payload", () => {
    // Routing stores these paths in `webhookEventPath` / `webhookCorrelationPath`
    // and the server resolves them with `getValueByPath`. If the two ever drift,
    // the selector would offer a path the webhook handler cannot follow.
    const payload = {
      type: "appointment.create",
      data: { id: "appt_123" },
      items: [{ sku: "S1" }],
    };

    const resolved = flattenSchemaPathOptions(
      inferSchemaFromPayload(payload)
    ).map((option) => getValueByPath(payload, option.path));

    expect(resolved).toEqual([
      "appointment.create",
      { id: "appt_123" },
      "appt_123",
      [{ sku: "S1" }],
      "S1",
    ]);
  });
});

describe("config readers", () => {
  it("reads a string value and falls back when the key is missing or mistyped", () => {
    expect(readConfigString({ triggerType: "Webhook" }, "triggerType")).toBe(
      "Webhook"
    );
    expect(readConfigString({}, "triggerType")).toBe("");
    expect(readConfigString({ triggerType: 7 }, "triggerType", "Webhook")).toBe(
      "Webhook"
    );
  });

  it("parses a stored field array", () => {
    expect(
      readSchemaFromConfigKey(
        { webhookSchema: JSON.stringify([{ name: "event", type: "string" }]) },
        "webhookSchema"
      )
    ).toEqual([{ name: "event", type: "string" }]);
  });

  it("parses a stored JSON Schema document", () => {
    expect(
      readSchemaFromConfigKey(
        {
          webhookSchema: JSON.stringify({
            type: "object",
            properties: { event: { type: "string" } },
          }),
        },
        "webhookSchema"
      )
    ).toEqual([{ name: "event", type: "string" }]);
  });

  it("returns nothing when the stored value is absent or unparseable", () => {
    expect(readSchemaFromConfigKey({}, "webhookSchema")).toEqual([]);
    expect(
      readSchemaFromConfigKey({ webhookSchema: "" }, "webhookSchema")
    ).toEqual([]);
    expect(
      readSchemaFromConfigKey({ webhookSchema: "{not json" }, "webhookSchema")
    ).toEqual([]);
    expect(
      readSchemaFromConfigKey({ webhookSchema: 5 }, "webhookSchema")
    ).toEqual([]);
  });

  it("reads the request and output schemas from their own keys", () => {
    const config = {
      webhookSchema: JSON.stringify([{ name: "event", type: "string" }]),
      webhookOutputSchema: JSON.stringify([{ name: "id", type: "string" }]),
    };

    expect(readWebhookRequestSchema(config)).toEqual([
      { name: "event", type: "string" },
    ]);
    expect(readWebhookOutputSchema(config)).toEqual([
      { name: "id", type: "string" },
    ]);
  });
});

describe("webhookRequestSchemaPatch", () => {
  it("carries the trigger output contract along with the request contract", () => {
    const schema = [{ name: "event", type: "string" as const }];

    expect(webhookRequestSchemaPatch(schema)).toEqual({
      webhookSchema: JSON.stringify(schema),
      webhookOutputSchema: JSON.stringify(schema),
    });
  });

  it("clears the trigger output contract when the request schema is cleared", () => {
    // The desync this rule exists to prevent: the JSON editor used to write
    // webhookSchema: "" on its own and leave webhookOutputSchema behind, so
    // template autocomplete kept offering fields from a deleted schema.
    expect(webhookRequestSchemaPatch(null)).toEqual({
      webhookSchema: "",
      webhookOutputSchema: "",
    });
  });

  it("treats a schema with no fields as an empty contract, not a cleared one", () => {
    expect(webhookRequestSchemaPatch([])).toEqual({
      webhookSchema: "[]",
      webhookOutputSchema: "[]",
    });
  });
});

describe("webhookOutputSchemaPatch", () => {
  it("writes the output contract alone, leaving the request contract untouched", () => {
    const schema = [{ name: "id", type: "string" as const }];

    expect(webhookOutputSchemaPatch(schema)).toEqual({
      webhookOutputSchema: JSON.stringify(schema),
    });
    expect(webhookOutputSchemaPatch(null)).toEqual({ webhookOutputSchema: "" });
  });
});

describe("parseSchemaJsonEdit", () => {
  it("reports an emptied editor as a clear rather than an error", () => {
    expect(parseSchemaJsonEdit("")).toEqual({ ok: true, schema: null });
    expect(parseSchemaJsonEdit("   \n ")).toEqual({ ok: true, schema: null });
  });

  it("clearing the request schema JSON clears both webhook schema keys", () => {
    // This is the whole live path of the JSON editor's clear branch: read the
    // edit, then hand its schema to the pairing rule.
    const edit = parseSchemaJsonEdit("");
    if (!edit.ok) {
      throw new Error("an emptied editor is a clear, not a parse failure");
    }

    expect(webhookRequestSchemaPatch(edit.schema)).toEqual({
      webhookSchema: "",
      webhookOutputSchema: "",
    });
  });

  it("accepts a field array", () => {
    expect(parseSchemaJsonEdit('[{"name":"event","type":"string"}]')).toEqual({
      ok: true,
      schema: [{ name: "event", type: "string" }],
    });
  });

  it("accepts a JSON Schema document", () => {
    expect(
      parseSchemaJsonEdit(
        '{"type":"object","properties":{"event":{"type":"string"}}}'
      )
    ).toEqual({ ok: true, schema: [{ name: "event", type: "string" }] });
  });

  it("explains unparseable text instead of writing over the stored schema", () => {
    expect(parseSchemaJsonEdit("{not json")).toEqual({
      ok: false,
      error: "Schema is not valid JSON.",
    });
  });

  it("explains JSON that is not a schema at all", () => {
    expect(parseSchemaJsonEdit("42")).toEqual({
      ok: false,
      error:
        "Schema must be either a field array or a JSON Schema object with top-level properties.",
    });
  });
});

describe("webhookSchemaPatchFromSamplePayload", () => {
  it("treats a pasted sample payload as a statement of the request contract", () => {
    const inferred = JSON.stringify([
      { name: "type", type: "string" },
      {
        name: "data",
        type: "object",
        fields: [{ name: "id", type: "string" }],
      },
    ]);

    expect(
      webhookSchemaPatchFromSamplePayload(
        '{"type":"appointment.create","data":{"id":"appt_1"}}'
      )
    ).toEqual({ webhookSchema: inferred, webhookOutputSchema: inferred });
  });

  it("leaves both schemas alone when the payload teaches nothing", () => {
    expect(webhookSchemaPatchFromSamplePayload("")).toEqual({});
    expect(webhookSchemaPatchFromSamplePayload("{half typed")).toEqual({});
    expect(webhookSchemaPatchFromSamplePayload("[1,2,3]")).toEqual({});
  });
});

describe("isSchemaEditorMode", () => {
  it("accepts only the two editor tabs", () => {
    expect(isSchemaEditorMode("builder")).toBe(true);
    expect(isSchemaEditorMode("json")).toBe(true);
    expect(isSchemaEditorMode("yaml")).toBe(false);
  });
});
