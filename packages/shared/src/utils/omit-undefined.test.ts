import { describe, expect, expectTypeOf, it } from "vitest";
import { omitUndefined } from "#src/utils/omit-undefined";

describe("omitUndefined", () => {
  it("drops the keys whose value is undefined", () => {
    const result = omitUndefined({ kept: 1, dropped: undefined });

    expect(Object.hasOwn(result, "dropped")).toBe(false);
    expect(result).toEqual({ kept: 1 });
  });

  it("keeps null, the empty string, zero and false", () => {
    const result = omitUndefined({
      nothing: null,
      empty: "",
      zero: 0,
      no: false,
    });

    expect(result).toEqual({ nothing: null, empty: "", zero: 0, no: false });
  });

  it("returns a new object and leaves the input alone", () => {
    const input = { kept: 1, dropped: undefined };
    const result = omitUndefined(input);

    expect(result).not.toBe(input);
    expect(Object.hasOwn(input, "dropped")).toBe(true);
  });

  it("constructs __proto__ as data without changing the prototype", () => {
    // A wire payload can carry a `__proto__` key. Assigning it with
    // `result[key] = value` would reach the prototype setter and lose the key,
    // so this pins the Object.fromEntries construction.
    const result = omitUndefined(
      Object.fromEntries([
        ["__proto__", "value"],
        ["missing", undefined],
      ])
    );

    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result).toEqual(Object.fromEntries([["__proto__", "value"]]));
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("keeps a required key required and makes an undefined-valued key optional", () => {
    const result = omitUndefined({} as { kept: string; maybe?: number });

    expectTypeOf(result).toEqualTypeOf<{ kept: string; maybe?: number }>();
  });

  it("reads an index-signature draft back without undefined in its values", () => {
    const result = omitUndefined({} as { [key: string]: string | undefined });

    expectTypeOf(result).toEqualTypeOf<{ [key: string]: string }>();
  });
});
