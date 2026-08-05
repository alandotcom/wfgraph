import { describe, expect, it } from "vitest";
import { matchesShowWhen } from "./show-when";

describe("matchesShowWhen", () => {
  it("holds when there is no showWhen", () => {
    expect(matchesShowWhen({}, undefined)).toBe(true);
    expect(matchesShowWhen(undefined, undefined)).toBe(true);
  });

  it("holds only when the named config key equals the declared value", () => {
    const showWhen = { field: "waitMode", equals: "event" };

    expect(matchesShowWhen({ waitMode: "event" }, showWhen)).toBe(true);
    expect(matchesShowWhen({ waitMode: "delay" }, showWhen)).toBe(false);
    expect(matchesShowWhen({}, showWhen)).toBe(false);
    expect(matchesShowWhen(undefined, showWhen)).toBe(false);
  });
});
