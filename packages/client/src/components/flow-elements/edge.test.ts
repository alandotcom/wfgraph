import { describe, expect, it } from "vitest";
import {
  comparisonEdgeStyle,
  heldDashes,
  heldOnScreen,
} from "#src/components/flow-elements/edge";

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

describe("strokes held on screen", () => {
  it("draws a width in flow pixels, and never under that many screen pixels while zoomed out", () => {
    expect(heldOnScreen(2)).toBe("max(2px, calc(2px / var(--rf-zoom, 1)))");
  });

  it("holds each length of a dash pattern the same way, and leaves no dash alone", () => {
    expect(heldDashes("7, 4")).toBe(
      "max(7px, calc(7px / var(--rf-zoom, 1))), max(4px, calc(4px / var(--rf-zoom, 1)))"
    );
    expect(heldDashes("5")).toBe("max(5px, calc(5px / var(--rf-zoom, 1)))");
    expect(heldDashes("none")).toBe("none");
  });
});
