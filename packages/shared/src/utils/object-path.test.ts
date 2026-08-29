import { describe, expect, it } from "vitest";
import { getValueByPath, setValueByPath } from "#src/utils/object-path";

describe("getValueByPath", () => {
  it("refuses a malformed array index instead of reading its numeric prefix", () => {
    const value = [{ id: "zero" }, { id: "one" }];

    expect(getValueByPath(value, "1oops.id")).toBeUndefined();
    expect(getValueByPath(value, "1.id")).toBe("one");
  });

  it("does not read inherited object properties", () => {
    expect(getValueByPath({}, "constructor.name")).toBeUndefined();
  });
});

describe("setValueByPath", () => {
  it("refuses prototype path segments without mutating Object.prototype", () => {
    const target = {};

    expect(setValueByPath(target, "__proto__.polluted", true)).toBe(target);
    expect(
      (Object.prototype as Record<string, unknown>).polluted
    ).toBeUndefined();
    expect(target).toEqual({});
  });
});
