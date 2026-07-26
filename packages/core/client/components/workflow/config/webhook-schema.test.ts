import { describe, expect, it } from "bun:test";
import { getValueByPath } from "@/shared/utils/object-path";
import {
  flattenSchemaPathOptions,
  inferPrimitiveType,
  inferSchemaField,
  inferSchemaFromPayload,
  isIso8601Timestamp,
  isSchemaEditorMode,
  readConfigString,
  readSchemaFromConfigKey,
  readWebhookOutputSchema,
  readWebhookRequestSchema,
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
    expect(readSchemaFromConfigKey({ webhookSchema: "" }, "webhookSchema")).toEqual(
      []
    );
    expect(
      readSchemaFromConfigKey({ webhookSchema: "{not json" }, "webhookSchema")
    ).toEqual([]);
    expect(readSchemaFromConfigKey({ webhookSchema: 5 }, "webhookSchema")).toEqual(
      []
    );
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

describe("isSchemaEditorMode", () => {
  it("accepts only the two editor tabs", () => {
    expect(isSchemaEditorMode("builder")).toBe(true);
    expect(isSchemaEditorMode("json")).toBe(true);
    expect(isSchemaEditorMode("yaml")).toBe(false);
  });
});
