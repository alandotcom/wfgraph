import { describe, expect, it } from "vitest";
import {
  canonicalizeNodeEnabled,
  persistedNodeEnabled,
} from "#src/graph/node-enabled";

describe("persistedNodeEnabled", () => {
  it("stores only the off state", () => {
    expect(persistedNodeEnabled(false)).toBe(false);
    expect(persistedNodeEnabled(true)).toBeUndefined();
    expect(persistedNodeEnabled(undefined)).toBeUndefined();
  });
});

describe("canonicalizeNodeEnabled", () => {
  it("drops enabled: true and leaves every other value alone", () => {
    expect(canonicalizeNodeEnabled({ enabled: true })).toEqual({});
    expect(canonicalizeNodeEnabled({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(canonicalizeNodeEnabled({})).toEqual({});
  });
});
