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
    expect(canonicalizeNodeEnabled({ label: "Send", enabled: true })).toEqual({
      label: "Send",
    });
    expect(canonicalizeNodeEnabled({ label: "Send", enabled: false })).toEqual({
      label: "Send",
      enabled: false,
    });
    expect(canonicalizeNodeEnabled({ label: "Send" })).toEqual({
      label: "Send",
    });
  });
});
