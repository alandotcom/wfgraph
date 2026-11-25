import { describe, expect, it } from "vitest";
import { rowKeyTarget } from "#src/hooks/use-list-row-keys";

describe("rowKeyTarget", () => {
  it("moves with the arrows and with J and K, held inside the list", () => {
    expect(rowKeyTarget("ArrowDown", 0, 3)).toBe(1);
    expect(rowKeyTarget("j", 1, 3)).toBe(2);
    expect(rowKeyTarget("j", 2, 3)).toBe(2);
    expect(rowKeyTarget("ArrowUp", 2, 3)).toBe(1);
    expect(rowKeyTarget("k", 0, 3)).toBe(0);
  });

  it("jumps to the ends with Home and End", () => {
    expect(rowKeyTarget("Home", 2, 3)).toBe(0);
    expect(rowKeyTarget("End", 0, 3)).toBe(2);
  });

  it("leaves every other key to the row", () => {
    expect(rowKeyTarget("Enter", 0, 3)).toBeNull();
    expect(rowKeyTarget(" ", 0, 3)).toBeNull();
    expect(rowKeyTarget("J", 0, 3)).toBeNull();
  });
});
