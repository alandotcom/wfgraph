import { describe, expect, it } from "vitest";
import type { JsonObject } from "#src/types/json";
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

    expect(setValueByPath(target, "__proto__.polluted", true)).toBe(false);
    expect(
      (Object.prototype as Record<string, unknown>).polluted
    ).toBeUndefined();
    expect(target).toEqual({});
  });

  it("reports a stored write, so a caller can tell one from a refusal", () => {
    const target: JsonObject = {};

    expect(setValueByPath(target, "order.customer.email", "a@b.test")).toBe(
      true
    );
    expect(target).toEqual({ order: { customer: { email: "a@b.test" } } });
  });
});
