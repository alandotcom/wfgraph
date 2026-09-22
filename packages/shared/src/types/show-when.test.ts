import { describe, expect, it } from "vitest";
import { matchesShowWhen } from "./show-when";

describe("matchesShowWhen", () => {
  it("holds when there is no showWhen", () => {
    expect(matchesShowWhen({}, undefined)).toBe(true);
    expect(matchesShowWhen(undefined, undefined)).toBe(true);
  });

  it("matches any listed literal without coercion or template resolution", () => {
    const showWhen = { field: "template", in: ["a", "b"] as const };

    expect(matchesShowWhen({ template: "a" }, showWhen)).toBe(true);
    expect(matchesShowWhen({ template: "b" }, showWhen)).toBe(true);
    for (const template of ["c", " a", "A", 1, null, ["a"], "{{@n1:value}}"]) {
      expect(matchesShowWhen({ template }, showWhen)).toBe(false);
    }
    expect(matchesShowWhen({}, showWhen)).toBe(false);
    expect(matchesShowWhen(undefined, showWhen)).toBe(false);
    expect(
      matchesShowWhen({ template: "a" }, { field: "template", in: [] })
    ).toBe(false);
  });

  it("holds only when the named config key equals the declared value", () => {
    const showWhen = { field: "waitMode", equals: "event" };

    expect(matchesShowWhen({ waitMode: "event" }, showWhen)).toBe(true);
    expect(matchesShowWhen({ waitMode: "delay" }, showWhen)).toBe(false);
    expect(matchesShowWhen({}, showWhen)).toBe(false);
    expect(matchesShowWhen(undefined, showWhen)).toBe(false);
  });
});
