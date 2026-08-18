import { Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { getWorkflowEdgePath } from "#src/components/flow-elements/edge-path";

describe("getWorkflowEdgePath", () => {
  it("routes with orthogonal segments and rounded corners", () => {
    const [path] = getWorkflowEdgePath({
      sourceX: 96,
      sourceY: 112,
      sourcePosition: Position.Bottom,
      targetX: 320,
      targetY: 216,
      targetPosition: Position.Top,
    });

    expect(path.startsWith("M")).toBe(true);
    expect(path).toContain("L");
    expect(path).toContain("Q");
  });
});
