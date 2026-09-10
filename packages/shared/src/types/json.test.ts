import { describe, expect, it } from "vitest";
import { isJsonObject, readJsonObjectLeniently, toJsonObject } from "./json";

describe("toJsonObject", () => {
  it("drops the keys whose value is undefined", () => {
    expect(toJsonObject({ kept: "value", missing: undefined })).toEqual({
      kept: "value",
    });
  });

  it("answers undefined for an undefined draft", () => {
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

  it("answers false for undefined", () => {
    expect(isJsonObject(undefined)).toBe(false);
  });

  it("answers true for an object", () => {
    expect(isJsonObject({})).toBe(true);
  });
});

describe("readJsonObjectLeniently", () => {
  it("drops a key holding undefined and keeps the rest of the object", () => {
    expect(
      readJsonObjectLeniently({
        subject: "Hello",
        integrationId: undefined,
      })
    ).toEqual({ subject: "Hello" });
  });

  it("drops an undefined key nested inside an array element", () => {
    expect(
      readJsonObjectLeniently({
        waitFor: [{ event: "order/paid", match: undefined }],
      })
    ).toEqual({ waitFor: [{ event: "order/paid" }] });
  });

  it("keeps an element position by writing null for a value JSON cannot carry", () => {
    expect(readJsonObjectLeniently({ items: ["a", new Date(), "b"] })).toEqual({
      items: ["a", null, "b"],
    });
  });

  it("keeps a key named __proto__ as data", () => {
    const json = readJsonObjectLeniently(
      JSON.parse('{"__proto__": {"polluted": true}}') as unknown
    );

    expect(Object.hasOwn(json ?? {}, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("answers null for a value that is not an object", () => {
    expect(readJsonObjectLeniently(["a"])).toBeNull();
    expect(readJsonObjectLeniently("a")).toBeNull();
    expect(readJsonObjectLeniently(undefined)).toBeNull();
  });
});
