import { describe, expect, it } from "vitest";
import { rewriteCelExpression } from "#src/workflow/inngest-event-data";

const payloadKeys = ["event", "appointment"];

describe("rewriteCelExpression", () => {
  it("rewrites a schema-relative identifier to the event.data. form", () => {
    expect(
      rewriteCelExpression(
        'appointment.priority == "high" ? 100 : 50',
        payloadKeys
      )
    ).toBe('event.data.appointment.priority == "high" ? 100 : 50');
  });

  it("rewrites every identifier in the expression, rightmost first", () => {
    expect(
      rewriteCelExpression(
        'event == "urgent" ? 100 : appointment.priority',
        payloadKeys
      )
    ).toBe(
      'event.data.event == "urgent" ? 100 : event.data.appointment.priority'
    );
  });

  it("leaves an expression with no identifiers unchanged", () => {
    expect(rewriteCelExpression("100", payloadKeys)).toBe("100");
  });

  it("refuses an identifier the payload does not declare", () => {
    expect(() =>
      rewriteCelExpression('unknownVar == "high" ? 100 : 50', payloadKeys)
    ).toThrow('Invalid identifier "unknownVar" in priority.run CEL expression');
  });

  // A library that publishes no field names leaves nothing to check against, and
  // refusing every identifier would make such a library unusable.
  it("rewrites without checking when no field names are known", () => {
    expect(rewriteCelExpression("whatever > 1", undefined)).toBe(
      "event.data.whatever > 1"
    );
  });

  it("refuses an expression that is not CEL", () => {
    expect(() =>
      rewriteCelExpression("appointment.priority ===", payloadKeys)
    ).toThrow("Invalid CEL expression in priority.run");
  });
});
