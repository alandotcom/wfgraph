import { type InternalNode, Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { OUTLET_LABEL_SIZE, outletPlacement } from "./reveal-outlets";

/** An internal node at `x, y`, 200 by 100, with the handles given. */
function internal(
  id: string,
  x: number,
  y: number,
  handles?: {
    source: Array<{ id: string; x: number; y?: number; position?: Position }>;
    target?: { x: number; y: number; position: Position };
  }
): InternalNode {
  return {
    id,
    position: { x, y },
    data: {},
    measured: { width: 200, height: 100 },
    internals: {
      positionAbsolute: { x, y },
      z: 0,
      userNode: { id, position: { x, y }, data: {} },
      handleBounds: handles
        ? {
            source: handles.source.map((handle) => ({
              id: handle.id,
              type: "source",
              nodeId: id,
              position: handle.position ?? Position.Bottom,
              x: handle.x,
              y: handle.y ?? 94,
              width: 12,
              height: 12,
            })),
            target: [
              {
                id: null,
                type: "target",
                nodeId: id,
                position: handles.target?.position ?? Position.Top,
                x: handles.target?.x ?? 94,
                y: handles.target?.y ?? -6,
                width: 12,
                height: 12,
              },
            ],
          }
        : undefined,
    },
  } as InternalNode;
}

const NODE_BOUNDS = { x: 0, y: 0, width: 200, height: 100 };

describe("outletPlacement", () => {
  it("is the node alone before its handles are measured", () => {
    const nodes = new Map([["condition", internal("condition", 0, 0)]]);
    expect(
      outletPlacement({
        nodeId: "condition",
        nodeBounds: NODE_BOUNDS,
        edges: [],
        getInternalNode: (id) => nodes.get(id),
      })
    ).toEqual({ bounds: NODE_BOUNDS, labels: [] });
  });

  it("holds both outlet handles, and lists the label of each edge leaving them", () => {
    const nodes = new Map([
      [
        "condition",
        internal("condition", 0, 0, {
          source: [
            { id: "true", x: 70 },
            { id: "false", x: 118 },
          ],
        }),
      ],
      ["yes", internal("yes", -300, 400, { source: [] })],
      ["no", internal("no", 300, 200, { source: [] })],
    ]);
    const placement = outletPlacement({
      nodeId: "condition",
      nodeBounds: NODE_BOUNDS,
      edges: [
        { source: "condition", sourceHandle: "true", target: "yes" },
        { source: "condition", sourceHandle: "false", target: "no" },
        { source: "yes", sourceHandle: null, target: "no" },
        { source: "condition", sourceHandle: "false", target: "missing" },
      ],
      getInternalNode: (id) => nodes.get(id),
    });

    // The handles end at y 106. The True edge runs from (76, 106) to
    // (-200, 394), so its label centers at (-62, 250). The False edge runs from
    // (124, 106) to (400, 194), so its label centers at (262, 150). Each label
    // box is 56 by 24.
    expect(OUTLET_LABEL_SIZE).toEqual({ width: 56, height: 24 });
    expect(placement).toEqual({
      bounds: { x: 0, y: 0, width: 200, height: 106 },
      labels: [
        { x: -90, y: 238, width: 56, height: 24 },
        { x: 234, y: 138, width: 56, height: 24 },
      ],
    });
  });

  it("places the labels of a Condition in a Left to right Group along edges leaving its right side", () => {
    const left = { x: -6, y: 44, position: Position.Left };
    const nodes = new Map([
      [
        "condition",
        internal("condition", 0, 0, {
          source: [
            { id: "true", x: 194, y: 32, position: Position.Right },
            { id: "false", x: 194, y: 56, position: Position.Right },
          ],
          target: left,
        }),
      ],
      ["yes", internal("yes", 400, -200, { source: [], target: left })],
      ["no", internal("no", 400, 200, { source: [], target: left })],
    ]);
    const placement = outletPlacement({
      nodeId: "condition",
      nodeBounds: NODE_BOUNDS,
      edges: [
        { source: "condition", sourceHandle: "true", target: "yes" },
        { source: "condition", sourceHandle: "false", target: "no" },
      ],
      getInternalNode: (id) => nodes.get(id),
    });

    // The handles end at x 206. The True edge runs from (206, 38) to
    // (394, -150), so its label centers at (300, -56). The False edge runs from
    // (206, 62) to (394, 250), so its label centers at (300, 156).
    expect(placement).toEqual({
      bounds: { x: 0, y: 0, width: 206, height: 100 },
      labels: [
        { x: 272, y: -68, width: 56, height: 24 },
        { x: 272, y: 144, width: 56, height: 24 },
      ],
    });
  });
});
