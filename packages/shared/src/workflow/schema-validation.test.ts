import { describe, expect, it } from "vitest";
import { validateWorkflowOutputAgainstSchema } from "#src/workflow/schema-validation";

describe("validateWorkflowOutputAgainstSchema", () => {
  it("returns ok when schema is not configured", () => {
    const result = validateWorkflowOutputAgainstSchema({
      schemaValue: "",
      output: { any: "value" },
      contextLabel: "Database Query",
    });

    expect(result).toEqual({ ok: true });
  });

  it("accepts output with extra fields via passthrough", () => {
    const result = validateWorkflowOutputAgainstSchema({
      schemaValue: JSON.stringify([
        { name: "rows", type: "array", itemType: "object", fields: [] },
      ]),
      output: {
        rows: [{ id: "1" }],
        count: 1,
        success: true,
      },
      contextLabel: "Database Query",
    });

    expect(result).toEqual({ ok: true });
  });

  it("supports JSON Schema document strings", () => {
    const result = validateWorkflowOutputAgainstSchema({
      schemaValue: JSON.stringify({
        type: "object",
        properties: {
          event: { type: "string" },
          data: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
          },
        },
      }),
      output: {
        event: "appointment.created",
        data: { id: "appt_1" },
        triggered: true,
      },
      contextLabel: "Webhook trigger",
    });

    expect(result).toEqual({ ok: true });
  });

  it("returns an invalid-schema error when schema JSON is malformed", () => {
    const result = validateWorkflowOutputAgainstSchema({
      schemaValue: "{not-json",
      output: { rows: [] },
      contextLabel: "Database Query",
    });

    expect(result).toEqual({
      ok: false,
      error: "Database Query schema is invalid: Schema is not valid JSON.",
    });
  });

  it("returns issue paths when output fails validation", () => {
    const result = validateWorkflowOutputAgainstSchema({
      schemaValue: JSON.stringify([
        {
          name: "rows",
          type: "array",
          itemType: "object",
          fields: [{ name: "id", type: "string" }],
        },
      ]),
      output: {
        rows: [{ id: 12 }],
      },
      contextLabel: "Database Query",
    });

    expect(result).toEqual({
      ok: false,
      error:
        "Database Query output does not match schema: rows[0].id: Invalid input: expected string, received number",
    });
  });
});
