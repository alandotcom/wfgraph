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

  it("rejects primitives where an object with no declared fields was asked for", () => {
    const result = validateWorkflowOutputAgainstSchema({
      schemaValue: JSON.stringify([
        { name: "rows", type: "array", itemType: "object", fields: [] },
      ]),
      output: { rows: [1, 2, 3] },
      contextLabel: "Database Query",
    });

    expect(result).toEqual({
      ok: false,
      error:
        "Database Query output does not match schema: rows[0]: Expected an object, got 1; rows[1]: Expected an object, got 2; rows[2]: Expected an object, got 3",
    });
  });

  it("rejects a primitive where a bare object field was asked for", () => {
    const result = validateWorkflowOutputAgainstSchema({
      schemaValue: JSON.stringify([{ name: "meta", type: "object" }]),
      output: { meta: 5 },
      contextLabel: "Database Query",
    });

    expect(result).toEqual({
      ok: false,
      error:
        "Database Query output does not match schema: meta: Expected an object, got 5",
    });
  });

  it("names the type a missing field was declared as", () => {
    const result = validateWorkflowOutputAgainstSchema({
      schemaValue: JSON.stringify([{ name: "id", type: "string" }]),
      output: {},
      contextLabel: "HTTP Request",
    });

    expect(result).toEqual({
      ok: false,
      error:
        "HTTP Request output does not match schema: id: Expected string, got no value",
    });
  });

  it("keeps a rejected value out of the message", () => {
    // The message is persisted as the run's step error and written to the log,
    // so a response body full of addresses and tokens must not travel into it.
    const secret = "sk_live_".padEnd(4000, "x");
    const result = validateWorkflowOutputAgainstSchema({
      schemaValue: JSON.stringify([
        { name: "id", type: "string" },
        { name: "attempts", type: "number" },
      ]),
      output: {
        id: { email: "someone@example.com", token: secret },
        attempts: secret,
      },
      contextLabel: "HTTP Request",
    });

    expect(result).toEqual({
      ok: false,
      error:
        'HTTP Request output does not match schema: id: Expected string, got an object; attempts: Expected number, got "sk_live_xxxxxxxxxxxx..."',
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
        "Database Query output does not match schema: rows[0].id: Expected string, got 12",
    });
  });
});
