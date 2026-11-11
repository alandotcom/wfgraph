import { describe, expect, it } from "vitest";
import type { JsonObject } from "@wfgraph/shared/types/json";
import {
  compactInputSchema,
  compactOutputSchema,
} from "#src/backend/agent/mcp-schema-compaction";

const rule: JsonObject = {
  type: "object",
  properties: {
    field: {
      type: "string",
      description: "The payload path the rule reads, such as applicantId.",
    },
    operator: {
      type: "string",
      description: "How the value at field is compared against value.",
    },
  },
  required: ["field", "operator"],
  additionalProperties: true,
};

describe("compactInputSchema", () => {
  it("moves the largest repeated subschema into $defs and references it", () => {
    const compacted = compactInputSchema({
      type: "object",
      properties: {
        startRules: { type: "array", items: rule },
        cancelRules: { type: "array", items: rule },
      },
      additionalProperties: false,
    });

    expect(compacted).toEqual({
      type: "object",
      properties: {
        startRules: { $ref: "#/$defs/startRules" },
        cancelRules: { $ref: "#/$defs/startRules" },
      },
      additionalProperties: false,
      $defs: {
        startRules: {
          type: "array",
          items: {
            type: "object",
            properties: rule.properties ?? {},
            required: ["field", "operator"],
          },
        },
      },
    });
  });

  it("leaves a schema with no repeats as it was, less default keys", () => {
    expect(
      compactInputSchema({
        type: "object",
        properties: { only: rule },
        additionalProperties: false,
      })
    ).toEqual({
      type: "object",
      properties: {
        only: {
          type: "object",
          properties: rule.properties ?? {},
          required: ["field", "operator"],
        },
      },
      additionalProperties: false,
    });
  });
});

describe("compactOutputSchema", () => {
  it("drops description annotations and keeps a property named description", () => {
    expect(
      compactOutputSchema({
        type: "object",
        description: "A step.",
        properties: {
          description: { type: "string", description: "The step's text." },
        },
        additionalProperties: false,
      })
    ).toEqual({
      type: "object",
      properties: { description: { type: "string" } },
      additionalProperties: false,
    });
  });
});
