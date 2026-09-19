import { describe, expect, it } from "vitest";
import {
  readRememberedRevealWidth,
  rememberedRevealWidthCookie,
} from "./reveal-width-preference";

const cookie = (value: unknown) => encodeURIComponent(JSON.stringify(value));

describe("readRememberedRevealWidth", () => {
  it("reads a valid shared width", () => {
    expect(readRememberedRevealWidth(cookie({ width: 700 }))).toBe(700);
  });

  it("round-trips the value the preference writes", () => {
    expect(readRememberedRevealWidth(rememberedRevealWidthCookie(844))).toBe(
      844
    );
    expect(
      readRememberedRevealWidth(rememberedRevealWidthCookie(undefined))
    ).toBeUndefined();
  });

  it.each([
    { name: "no cookie", value: undefined },
    { name: "an empty value", value: "" },
    { name: "text that is not JSON", value: "wide" },
    { name: "a malformed escape", value: "%E0%A4%A" },
    { name: "a JSON array", value: cookie([420, 700]) },
    { name: "a JSON number", value: cookie(700) },
  ])("reads $name as no remembered width", ({ value }) => {
    expect(readRememberedRevealWidth(value)).toBeUndefined();
  });

  it.each([
    { width: "700", reason: "text" },
    { width: 700.5, reason: "a fractional pixel" },
    { width: null, reason: "null" },
    { width: true, reason: "a boolean" },
    { width: 479, reason: "a value below the minimum" },
  ])("drops $reason", ({ width }) => {
    expect(readRememberedRevealWidth(cookie({ width }))).toBeUndefined();
  });

  it("does not reuse legacy family widths", () => {
    expect(
      readRememberedRevealWidth(
        cookie({ browse: 420, compact: 420, standard: 700, wide: 960 })
      )
    ).toBeUndefined();
  });

  it("ignores keys it does not know", () => {
    expect(
      readRememberedRevealWidth(cookie({ width: 700, sidebar: 300 }))
    ).toBe(700);
  });
});
