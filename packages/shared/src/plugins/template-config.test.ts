import { describe, expect, it } from "vitest";
import {
  extractConsumedTemplateReferences,
  readConfigValue,
} from "#src/plugins/template-config";

const entityToken = '{{@$entity:patient|Patient.tags["order.id"]}}';
const rules = {
  literalKeys: new Set<string>(),
  jsonShapes: new Map([
    ["headers", "key-value" as const],
    ["variables", "provider-fields" as const],
  ]),
};

describe("extractConsumedTemplateReferences", () => {
  it("decodes JSON-backed fields before reading their template values", () => {
    const references = extractConsumedTemplateReferences(
      {
        headers: JSON.stringify([{ name: entityToken, value: entityToken }]),
        variables: JSON.stringify({ CUSTOMER: entityToken, COUNT: 2 }),
      },
      rules
    );

    expect(references).toEqual([
      expect.objectContaining({
        configKey: "headers",
        field: "headers.0.value",
        fieldPath: 'tags["order.id"]',
      }),
      expect.objectContaining({
        configKey: "variables",
        field: "variables.CUSTOMER",
        fieldPath: 'tags["order.id"]',
      }),
    ]);
  });

  it("keeps a dotted top-level config key separate from its display location", () => {
    expect(
      extractConsumedTemplateReferences(
        { "delivery.message": entityToken },
        { literalKeys: new Set(), jsonShapes: new Map() }
      )
    ).toEqual([
      expect.objectContaining({
        configKey: "delivery.message",
        field: "delivery.message",
      }),
    ]);
  });

  it("ignores literal, inactive, and nested values execution does not consume", () => {
    expect(
      extractConsumedTemplateReferences(
        {
          active: entityToken,
          inactive: entityToken,
          literal: entityToken,
          condition: entityToken,
          nested: { value: entityToken },
        },
        {
          literalKeys: new Set(["literal"]),
          jsonShapes: new Map(),
          activeKeys: new Set(["active", "literal", "condition", "nested"]),
        }
      ).map((reference) => reference.field)
    ).toEqual(["active"]);
  });
});

describe("readConfigValue", () => {
  it("reads a plain string as one template", () => {
    expect(readConfigValue("subject", entityToken, rules)).toEqual({
      kind: "template",
      text: entityToken,
    });
  });

  it("answers stored for a value that is not a string", () => {
    expect(readConfigValue("priority", 2, rules)).toEqual({ kind: "stored" });
    expect(readConfigValue("tags", ["welcome"], rules)).toEqual({
      kind: "stored",
    });
  });

  it("answers stored for a declared literal key and a built-in literal key", () => {
    const literalRules = { ...rules, literalKeys: new Set(["testAddress"]) };

    expect(readConfigValue("testAddress", entityToken, literalRules)).toEqual({
      kind: "stored",
    });
    expect(readConfigValue("condition", entityToken, rules)).toEqual({
      kind: "stored",
    });
  });

  it("answers stored for a key the action's current shape does not read", () => {
    expect(
      readConfigValue("subject", entityToken, {
        ...rules,
        activeKeys: new Set(["other"]),
      })
    ).toEqual({ kind: "stored" });
  });

  it("reads key-value text as its rows", () => {
    expect(
      readConfigValue(
        "headers",
        JSON.stringify([{ name: "X-Member", value: entityToken }]),
        rules
      )
    ).toEqual({
      kind: "key-value",
      rows: [{ name: "X-Member", value: entityToken }],
    });
  });

  it("reads key-value text that holds no rows as one template", () => {
    expect(readConfigValue("headers", "not rows", rules)).toEqual({
      kind: "template",
      text: "not rows",
    });
  });

  it("reads provider-fields text as its entries", () => {
    expect(
      readConfigValue(
        "variables",
        JSON.stringify({ CUSTOMER: entityToken, COUNT: 2 }),
        rules
      )
    ).toEqual({
      kind: "provider-fields",
      entries: { CUSTOMER: entityToken, COUNT: 2 },
    });
  });

  it("reads provider-fields text that holds no entries as one template", () => {
    expect(readConfigValue("variables", "[1, 2]", rules)).toEqual({
      kind: "template",
      text: "[1, 2]",
    });
  });
});
