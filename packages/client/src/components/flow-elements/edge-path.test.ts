import { type InternalNode, Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  getEdgeParams,
  getWorkflowEdgePath,
} from "#src/components/flow-elements/edge-path";

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

  /** Every point an SVG path names, in order. */
  function pointsOf(path: string): { x: number; y: number }[] {
    return [...path.matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
    }));
  }

  it("turns where the edge's turnAlong says, before the rank it reaches", () => {
    // Top to bottom: the source's bottom handle is at 112 and the target's top
    // handle two ranks down, so the cross segment runs just above the target.
    const skipping = {
      sourceX: 0,
      sourceY: 112,
      sourcePosition: Position.Bottom,
      targetX: 300,
      targetY: 544,
      targetPosition: Position.Top,
    };
    const [vertical, , labelY] = getWorkflowEdgePath(skipping, {
      turnAlong: 500,
    });
    expect(labelY).toBe(500);
    // The path leaves along x = 0 until that turn, so it passes the rank
    // between the two ends in the source's lane.
    for (const point of pointsOf(vertical)) {
      if (point.y < 500 - 16) {
        expect(point.x).toBe(0);
      }
    }

    // Left to right mirrors it on the other axis.
    const [, labelX] = getWorkflowEdgePath(
      {
        sourceX: 192,
        sourceY: 0,
        sourcePosition: Position.Right,
        targetX: 800,
        targetY: 200,
        targetPosition: Position.Left,
      },
      { turnAlong: 760 }
    );
    expect(labelX).toBe(760);
  });

  it("turns halfway when the edge carries no turn, or one outside its ends", () => {
    const forward = {
      sourceX: 0,
      sourceY: 112,
      sourcePosition: Position.Bottom,
      targetX: 300,
      targetY: 544,
      targetPosition: Position.Top,
    };
    const halfway = (112 + 544) / 2;
    expect(getWorkflowEdgePath(forward)[2]).toBe(halfway);
    expect(getWorkflowEdgePath(forward, { turnAlong: 600 })[2]).toBe(halfway);
    expect(getWorkflowEdgePath(forward, { turnAlong: 112 })[2]).toBe(halfway);
  });
});

/** An internal node at `x, y`, 200 by 100, with one handle of each type. */
function cardWithHandles(
  id: string,
  x: number,
  y: number,
  sides: { source: Position; target: Position }
): InternalNode {
  const handleAt = (position: Position, type: "source" | "target") => ({
    id: null,
    nodeId: id,
    type,
    position,
    width: 12,
    height: 12,
    ...(position === Position.Right
      ? { x: 194, y: 44 }
      : position === Position.Left
        ? { x: -6, y: 44 }
        : position === Position.Bottom
          ? { x: 94, y: 94 }
          : { x: 94, y: -6 }),
  });
  return {
    id,
    position: { x, y },
    data: {},
    measured: { width: 200, height: 100 },
    internals: {
      positionAbsolute: { x, y },
      z: 0,
      userNode: { id, position: { x, y }, data: {} },
      handleBounds: {
        source: [handleAt(sides.source, "source")],
        target: [handleAt(sides.target, "target")],
      },
    },
  } as InternalNode;
}

describe("getEdgeParams", () => {
  it("starts and ends a Top to bottom pair on the bottom and top handles", () => {
    const sides = { source: Position.Bottom, target: Position.Top };
    expect(
      getEdgeParams(
        cardWithHandles("a", 0, 0, sides),
        cardWithHandles("b", 0, 200, sides)
      )
    ).toEqual({
      sx: 100,
      sy: 106,
      tx: 100,
      ty: 194,
      sourcePos: Position.Bottom,
      targetPos: Position.Top,
    });
  });

  it("runs a Left to right pair from the right handle straight to the left handle", () => {
    const sides = { source: Position.Right, target: Position.Left };
    const params = getEdgeParams(
      cardWithHandles("a", 0, 0, sides),
      cardWithHandles("b", 300, 0, sides)
    );
    expect(params).toEqual({
      sx: 206,
      sy: 50,
      tx: 294,
      ty: 50,
      sourcePos: Position.Right,
      targetPos: Position.Left,
    });

    const [path] = getWorkflowEdgePath({
      sourceX: params.sx,
      sourceY: params.sy,
      sourcePosition: params.sourcePos,
      targetX: params.tx,
      targetY: params.ty,
      targetPosition: params.targetPos,
    });
    // Every point on the path stays on the line between the two handles, so
    // the edge neither drops below the cards nor turns back.
    const points = [...path.matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map(
      (match) => ({ x: Number(match[1]), y: Number(match[2]) })
    );
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(point.y).toBe(50);
      expect(point.x).toBeGreaterThanOrEqual(206);
      expect(point.x).toBeLessThanOrEqual(294);
    }
  });
});
