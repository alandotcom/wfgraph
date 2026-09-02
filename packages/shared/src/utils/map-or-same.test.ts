import { describe, expect, it } from "vitest";
import { mapOrSame, mapValuesOrSame } from "#src/utils/map-or-same";

describe("mapOrSame", () => {
  it("returns the input array when every element maps to itself", () => {
    const items = [{ id: "a" }, { id: "b" }];

    expect(mapOrSame(items, (item) => item)).toBe(items);
  });

  it("returns a new array holding the one replaced element", () => {
    const first = { id: "a" };
    const second = { id: "b" };
    const replacement = { id: "c" };

    const result = mapOrSame([first, second], (item) =>
      item === second ? replacement : item
    );

    expect(result).not.toBe(first);
    expect(result).toEqual([first, replacement]);
    expect(result[0]).toBe(first);
  });

  it("passes the index of each element", () => {
    expect(mapOrSame(["a", "b"], (item, index) => `${item}${index}`)).toEqual([
      "a0",
      "b1",
    ]);
  });
});

describe("mapValuesOrSame", () => {
  it("returns the input object when every value maps to itself", () => {
    const input = { first: { id: "a" }, second: { id: "b" } };

    expect(mapValuesOrSame(input, (value) => value)).toBe(input);
  });

  it("returns a new object holding the one replaced value", () => {
    const input = { first: 1, second: 2 };

    const result = mapValuesOrSame(input, (value, key) =>
      key === "second" ? 20 : value
    );

    expect(result).not.toBe(input);
    expect(result).toEqual({ first: 1, second: 20 });
  });

  it("keeps the key order of the input", () => {
    const input = { zebra: 1, apple: 2, mango: 3 };

    const result = mapValuesOrSame(input, (value) => value + 1);

    expect(Object.keys(result)).toEqual(["zebra", "apple", "mango"]);
  });

  it("constructs __proto__ as data without changing the prototype", () => {
    // A config read from JSON can carry an own `__proto__` key. Assigning it
    // with `result[key] = value` would reach the prototype setter and lose the
    // key, so this pins the Object.fromEntries construction.
    const input: Record<string, string> = Object.fromEntries([
      ["__proto__", "value"],
    ]);

    const result = mapValuesOrSame(input, (value) => value.toUpperCase());

    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result).toEqual(Object.fromEntries([["__proto__", "VALUE"]]));
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
