import { describe, expect, it } from "vitest";
import { comparisonEdgeStyle } from "#src/components/flow-elements/edge";

describe("comparisonEdgeStyle", () => {
  it("uses semantic colors and different dash patterns for added and removed edges", () => {
    expect(comparisonEdgeStyle({ kind: "added", sourceId: "e1" })).toEqual({
      stroke: "var(--success)",
      strokeDasharray: "7, 4",
      strokeWidth: 2.5,
    });
    expect(comparisonEdgeStyle({ kind: "removed", sourceId: "e1" })).toEqual({
      stroke: "var(--destructive)",
      strokeDasharray: "2, 5",
      strokeWidth: 2.5,
    });
  });
});
