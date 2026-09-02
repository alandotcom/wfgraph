import { describe, expect, it } from "vitest";
import { compareText, isBlank } from "#src/types/string";

/**
 * These expectations call `localeCompare` themselves instead of naming a
 * literal order, because `compareText` follows the collation of the ICU data
 * the running Node build ships.
 */
describe("compareText", () => {
  it("orders two words the way localeCompare does", () => {
    expect(Math.sign(compareText("apple", "banana"))).toBe(
      Math.sign("apple".localeCompare("banana"))
    );
  });

  it("compares mixed-case text the way localeCompare does", () => {
    expect(Math.sign(compareText("Zebra", "apple"))).toBe(
      Math.sign("Zebra".localeCompare("apple"))
    );
  });

  it("answers zero for the same text", () => {
    expect(compareText("apple", "apple")).toBe(0);
  });

  it("sorts mixed-case text alphabetically", () => {
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
