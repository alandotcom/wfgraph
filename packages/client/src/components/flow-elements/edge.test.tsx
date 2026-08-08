import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import {
  Edge,
  edgeXyflowDial,
} from "#src/components/flow-elements/edge";

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

beforeEach(() => {
  vi.spyOn(edgeXyflowDial, "BaseEdge").mockImplementation((({
    id,
    path,
    style,
  }: {
    id?: string;
    path: string;
    style?: Record<string, unknown>;
  }) =>
    createElement("div", {
      "data-testid": "base-edge",
      "data-edge-id": id,
      "data-edge-path": path,
      "data-edge-stroke": String(style?.stroke ?? ""),
      "data-edge-opacity": String(style?.opacity ?? ""),
    })) as never);
  vi.spyOn(edgeXyflowDial, "EdgeLabelRenderer").mockImplementation((({
    children,
  }: {
    children: ReactNode;
  }) =>
    createElement(
      "div",
      { "data-testid": "edge-label-layer" },
      children
    )) as never);
  vi.spyOn(edgeXyflowDial, "getBezierPath").mockReturnValue([
    "M0,0 C1,1 2,2 3,3",
    220,
    160,
  ] as never);
  vi.spyOn(edgeXyflowDial, "useInternalNode").mockImplementation(
    ((nodeId: string) => {
      if (nodeId === "source") {
        return sourceNode;
      }

      if (nodeId === "target") {
        return targetNode;
      }

      return undefined;
    }) as never
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderAnimatedEdge(
  sourceHandleId?: string,
  data?: { displayLabel?: string },
  style?: Record<string, unknown>
) {
  return render(
    createElement(
      Edge.Animated as (props: Record<string, unknown>) => ReactNode,
      {
        id: "edge_1",
        selected: false,
        source: "source",
        sourceHandleId,
        style: style ?? {},
        target: "target",
        targetHandleId: "in",
        data,
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

  it("renders a displayLabel and keeps muted opacity from style", () => {
    const view = renderAnimatedEdge(
      undefined,
      { displayLabel: "No Cancel Event" },
      { opacity: 0.4 }
    );

    expect(view.getByText("No Cancel Event")).toBeTruthy();
    expect(
      view.getByTestId("base-edge").getAttribute("data-edge-opacity")
    ).toBe("0.4");
  });
});
