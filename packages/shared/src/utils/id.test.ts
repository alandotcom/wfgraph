import { describe, expect, it } from "vitest";
import { generateId } from "#src/utils/id";

describe("generateId", () => {
  it("returns a lowercase UUID version 7 string", () => {
    expect(generateId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
  });

  it("orders two ids generated back to back as plain strings", () => {
    const first = generateId();
    const second = generateId();

    expect(first < second).toBe(true);
  });

  it("keeps a thousand ids strictly increasing, including within a millisecond", () => {
    const ids = Array.from({ length: 1000 }, () => generateId());
    const sorted = [...ids].sort();

    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
