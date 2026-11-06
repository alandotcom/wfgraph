import { describe, expect, it } from "vitest";
import { compileEventDataEquals } from "#src/lifecycle/inngest-event-data";

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
