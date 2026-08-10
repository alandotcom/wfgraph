import { describe, expect, it } from "vitest";
import { getValueByPath } from "#src/utils/object-path";

describe("getValueByPath", () => {
  it("refuses a malformed array index instead of reading its numeric prefix", () => {
    const value = [{ id: "zero" }, { id: "one" }];

    expect(getValueByPath(value, "1oops.id")).toBeUndefined();
    expect(getValueByPath(value, "1.id")).toBe("one");
  });
});
