import { parse as parseCel } from "@marcbachmann/cel-js";
import { describe, expect, it } from "vitest";
import { celStringLiteral } from "#src/workflow/cel-string-literal";

describe("celStringLiteral", () => {
  it("quotes a plain string", () => {
    expect(celStringLiteral("workflow_123")).toBe('"workflow_123"');
  });

  it("escapes a quote so the literal does not end early", () => {
    expect(celStringLiteral('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("doubles a backslash", () => {
    expect(celStringLiteral("a\\b")).toBe('"a\\\\b"');
  });

  // An apostrophe is ordinary inside the double-quoted form, which is half of
  // why that is the form Rova writes.
  it("leaves an apostrophe alone", () => {
    expect(celStringLiteral("it's")).toBe('"it\'s"');
  });

  // A raw newline or control character would end the literal at the line break
  // and leave CEL an expression it cannot parse.
  it("writes a newline and a control character as escapes", () => {
    expect(celStringLiteral("a\nb")).toBe('"a\\nb"');
    expect(celStringLiteral("a\u0007b")).toBe('"a\\u0007b"');
  });

  // The escaping only matters because a parser reads the result, so the awkward
  // values are held to producing an expression CEL accepts.
  it("produces an expression CEL parses", () => {
    for (const value of ["it's", 'say "hi"', "a\\b", "a\nb", "a\u0007b"]) {
      expect(() =>
        parseCel(`event.data.id == ${celStringLiteral(value)}`)
      ).not.toThrow();
    }
  });
});
