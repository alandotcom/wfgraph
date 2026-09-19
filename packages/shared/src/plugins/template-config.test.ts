import { describe, expect, it } from "vitest";
import { extractConsumedTemplateReferences } from "#src/plugins/template-config";

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
