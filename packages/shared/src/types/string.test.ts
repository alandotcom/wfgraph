import { describe, expect, it } from "vitest";
import { compareText, isBlank } from "#src/types/string";

/**
 * The expectations call `localeCompare` themselves rather than naming an order,
 * because the collation an ICU build ships is what `compareText` is defined to
 * follow. Pinning a literal order here would pin the Node build instead.
 */
describe("compareText", () => {
  it("orders two words the way localeCompare does", () => {
    expect(Math.sign(compareText("apple", "banana"))).toBe(
      Math.sign("apple".localeCompare("banana"))
    );
  });

  it("ignores case the way localeCompare does", () => {
    expect(Math.sign(compareText("Zebra", "apple"))).toBe(
      Math.sign("Zebra".localeCompare("apple"))
    );
  });

  it("answers zero for the same text", () => {
    expect(compareText("apple", "apple")).toBe(0);
  });

  it("sorts a list the way a reader expects", () => {
    expect(["banana", "Apple", "cherry"].toSorted(compareText)).toEqual([
      "Apple",
      "banana",
      "cherry",
    ]);
  });
});

describe("isBlank", () => {
  it("calls the empty string blank", () => {
    expect(isBlank("")).toBe(true);
  });

  it("calls whitespace blank", () => {
    expect(isBlank("  \t\n ")).toBe(true);
  });

  it("does not call a padded word blank", () => {
    expect(isBlank("  value  ")).toBe(false);
  });

  it("does not call zero blank", () => {
    expect(isBlank("0")).toBe(false);
  });
});
