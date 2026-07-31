import { describe, expect, it } from "vitest";
import {
  compileEventDataEquals,
  rewriteCelExpression,
} from "#src/lifecycle/inngest-event-data";

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

  // cel-js parses a comprehension macro's bound variable the same way it parses
  // a free identifier, so checking it against the schema keys would refuse a
  // valid expression and prefixing it would produce one Inngest cannot evaluate.
  it("leaves a macro's loop variable alone, checked or not", () => {
    expect(
      rewriteCelExpression("items.exists(i, i.x > 1) ? 100 : 50", ["items"])
    ).toBe("event.data.items.exists(i, i.x > 1) ? 100 : 50");
    expect(
      rewriteCelExpression("items.exists(i, i.x > 1) ? 100 : 50", undefined)
    ).toBe("event.data.items.exists(i, i.x > 1) ? 100 : 50");
  });
});

describe("compileEventDataEquals", () => {
  it("compares the payload path Inngest will see", () => {
    expect(
      compileEventDataEquals({ path: "event", equals: "appointment.canceled" })
    ).toBe('event.data.event == "appointment.canceled"');
  });

  it("reaches a nested path one segment at a time", () => {
    expect(
      compileEventDataEquals({ path: "meta.kind", equals: "created" })
    ).toBe('event.data.meta.kind == "created"');
  });

  // JSON.stringify is the escaping CEL wants, which is also what keeps an
  // apostrophe from ending the literal early.
  it("escapes a quote and a backslash in the value", () => {
    expect(compileEventDataEquals({ path: "kind", equals: "it's on" })).toBe(
      'event.data.kind == "it\'s on"'
    );
    expect(compileEventDataEquals({ path: "kind", equals: 'say "hi"' })).toBe(
      'event.data.kind == "say \\"hi\\""'
    );
    expect(compileEventDataEquals({ path: "kind", equals: "a\\b" })).toBe(
      'event.data.kind == "a\\\\b"'
    );
  });

  // A hyphen would read as a subtraction, so a segment that is not a plain
  // identifier is bracketed instead.
  it("brackets a segment CEL cannot read as a field", () => {
    expect(
      compileEventDataEquals({ path: "event-kind", equals: "created" })
    ).toBe('event.data["event-kind"] == "created"');
  });

  it("refuses a path that names nothing", () => {
    expect(() => compileEventDataEquals({ path: "  ", equals: "x" })).toThrow(
      "needs a payload path"
    );
  });
});
