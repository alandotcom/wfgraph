import { describe, expect, it, mock } from "bun:test";
import { render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

const sourceNode = {
  internals: {
    positionAbsolute: { x: 120, y: 80 },
    handleBounds: {
      source: [
        {
          id: "true",
          position: "bottom",
          x: 70,
          y: 180,
          width: 12,
          height: 12,
        },
        {
          id: "false",
          position: "bottom",
          x: 110,
          y: 180,
          width: 12,
          height: 12,
        },
      ],
    },
  },
};

const targetNode = {
  internals: {
    positionAbsolute: { x: 360, y: 120 },
    handleBounds: {
      target: [
        { id: "in", position: "top", x: 88, y: 0, width: 12, height: 12 },
      ],
    },
  },
};

mock.module("@xyflow/react", () => ({
  applyEdgeChanges: (_changes: unknown, edges: unknown[]) => edges,
  applyNodeChanges: (_changes: unknown, nodes: unknown[]) => nodes,
  BaseEdge: ({
    id,
    path,
    style,
  }: {
    id: string;
    path: string;
    style?: Record<string, unknown>;
  }) =>
    createElement("div", {
      "data-testid": "base-edge",
      "data-edge-id": id,
      "data-edge-path": path,
      "data-edge-stroke": String(style?.stroke ?? ""),
    }),
  EdgeLabelRenderer: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "edge-label-layer" }, children),
  Position: {
    Left: "left",
    Right: "right",
    Top: "top",
    Bottom: "bottom",
  },
  getBezierPath: () => ["M0,0 C1,1 2,2 3,3", 220, 160],
  getSimpleBezierPath: () => ["M0,0 C1,1 2,2 3,3"],
  useInternalNode: (nodeId: string) => {
    if (nodeId === "source") {
      return sourceNode;
    }

    if (nodeId === "target") {
      return targetNode;
    }

    return undefined;
  },
}));

const { Edge } = await import("@/components/flow-elements/edge");

function renderAnimatedEdge(sourceHandleId?: string) {
  return render(
    createElement(
      Edge.Animated as (props: Record<string, unknown>) => ReactNode,
      {
        id: "edge_1",
        selected: false,
        source: "source",
        sourceHandleId,
        style: {},
        target: "target",
        targetHandleId: "in",
      }
    )
  );
}

describe("Edge.Animated", () => {
  it("renders True label for true condition branch edges", () => {
    const view = renderAnimatedEdge("true");

    expect(view.getByText("True")).toBeTruthy();
    expect(view.queryByText("False")).toBeNull();
  });

  it("renders False label for false condition branch edges", () => {
    const view = renderAnimatedEdge("false");

    expect(view.getByText("False")).toBeTruthy();
    expect(view.queryByText("True")).toBeNull();
  });

  it("does not render branch labels for unlabeled edges", () => {
    const view = renderAnimatedEdge();

    expect(view.queryByText("True")).toBeNull();
    expect(view.queryByText("False")).toBeNull();
  });
});
