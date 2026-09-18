import { describe, expect, it } from "vitest";
import {
  readRememberedRevealWidths,
  rememberedRevealWidthsCookie,
} from "./reveal-width-preference";

const cookie = (value: unknown) => encodeURIComponent(JSON.stringify(value));

describe("readRememberedRevealWidths", () => {
  it("reads the three widths a valid cookie holds", () => {
    expect(
      readRememberedRevealWidths(
        cookie({ compact: 420, standard: 700, wide: 960 })
      )
    ).toEqual({ compact: 420, standard: 700, wide: 960 });
  });

  it("migrates the legacy Browse width to Compact", () => {
    expect(readRememberedRevealWidths(cookie({ browse: 420 }))).toEqual({
      compact: 420,
    });
  });

  it("round-trips the value the preference writes", () => {
    const widths = { compact: 344, wide: 1012 };
    expect(
      readRememberedRevealWidths(rememberedRevealWidthsCookie(widths))
    ).toEqual(widths);
  });

  it.each([
    { name: "no cookie", value: undefined },
    { name: "an empty value", value: "" },
    { name: "text that is not JSON", value: "wide" },
    { name: "a malformed escape", value: "%E0%A4%A" },
    { name: "a JSON array", value: cookie([420, 700]) },
    { name: "a JSON number", value: cookie(420) },
  ])("reads $name as no remembered widths", ({ value }) => {
    expect(readRememberedRevealWidths(value)).toEqual({});
  });

  it("drops each width that is not a whole number and keeps the rest", () => {
    expect(
      readRememberedRevealWidths(
        cookie({ compact: "420", standard: 700.5, wide: null })
      )
    ).toEqual({});
    expect(
      readRememberedRevealWidths(cookie({ compact: true, standard: 700 }))
    ).toEqual({ standard: 700 });
  });

  it("drops each width below its key's minimum", () => {
    expect(
      readRememberedRevealWidths(
        cookie({ compact: 319, standard: 479, wide: -900 })
      )
    ).toEqual({});
    expect(
      readRememberedRevealWidths(cookie({ compact: 320, standard: 480 }))
    ).toEqual({ compact: 320, standard: 480 });
  });

  it("ignores keys it does not know", () => {
    expect(
      readRememberedRevealWidths(cookie({ compact: 400, sidebar: 300 }))
    ).toEqual({ compact: 400 });
  });
});
