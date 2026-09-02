import { describe, expect, it } from "vitest";
import { isJsonObject, toJsonObject } from "./json";

describe("toJsonObject", () => {
  it("takes the valueless keys off a draft", () => {
    expect(toJsonObject({ kept: "value", missing: undefined })).toEqual({
      kept: "value",
    });
  });

  it("takes undefined through unchanged", () => {
    expect(toJsonObject(undefined)).toBeUndefined();
  });
});

describe("isJsonObject", () => {
  it("answers false for null", () => {
    expect(isJsonObject(null)).toBe(false);
  });

  it("answers false for an array", () => {
    expect(isJsonObject([1, 2])).toBe(false);
  });

  it("answers false for a string", () => {
    expect(isJsonObject("value")).toBe(false);
  });

  it("answers true for an object", () => {
    expect(isJsonObject({})).toBe(true);
  });
});
