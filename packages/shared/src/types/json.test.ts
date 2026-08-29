import { describe, expect, it } from "vitest";
import { toJsonObject } from "./json";

describe("toJsonObject", () => {
  it("constructs __proto__ as data without changing the prototype", () => {
    const result = toJsonObject(
      Object.fromEntries([
        ["__proto__", "value"],
        ["missing", undefined],
      ])
    );

    expect(result).toEqual(Object.fromEntries([["__proto__", "value"]]));
    expect(Object.hasOwn(result ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
