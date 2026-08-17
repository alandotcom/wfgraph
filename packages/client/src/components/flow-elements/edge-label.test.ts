import { describe, expect, it } from "vitest";
import { resolveEdgeLabel } from "#src/components/flow-elements/edge-label";

describe("resolveEdgeLabel", () => {
  it("reads True/False from a condition branch handle", () => {
    expect(resolveEdgeLabel("true", undefined)).toBe("True");
    expect(resolveEdgeLabel("false", undefined)).toBe("False");
  });

  it("falls back to displayLabel when the handle is not a branch", () => {
    expect(
      resolveEdgeLabel(undefined, { displayLabel: "No Cancel Event" })
    ).toBe("No Cancel Event");
  });

  it("answers null when nothing labels the edge", () => {
    expect(resolveEdgeLabel(undefined, undefined)).toBeNull();
    expect(resolveEdgeLabel("other", undefined)).toBeNull();
  });
});
