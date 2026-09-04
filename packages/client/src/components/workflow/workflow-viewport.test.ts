import { getNodesBounds, getViewportForBounds } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_CANVAS_MIN_ZOOM,
  initialWorkflowViewport,
  presentationViewport,
  workflowFitViewOptions,
  workflowZoomPresentation,
} from "#src/components/workflow/workflow-viewport";

describe("workflow viewport policy", () => {
  it("fits supported large workflow bounds into the shortest canvas with padding", () => {
    const canvas = { height: 314, width: 390 };
    const workflowBounds = ({
      columns,
      rankGap,
      siblingGap,
    }: {
      columns: number;
      rankGap: number;
      siblingGap: number;
    }) =>
      getNodesBounds(
        Array.from({ length: 50 }, (_, index) => ({
          id: `node-${index}`,
          data: {},
          initialHeight: 112,
          initialWidth: 192,
          position: {
            x: (index % columns) * (192 + siblingGap),
            y: Math.floor(index / columns) * (112 + rankGap),
          },
        }))
      );
    // The narrow layout uses the compact 64px rank gap.
    const narrowChain = workflowBounds({
      columns: 1,
      rankGap: 64,
      siblingGap: 0,
    });
    const wideWorkflow = workflowBounds({
      columns: 25,
      rankGap: 64,
      siblingGap: 96,
    });
    // Drafts saved before the compact spacing change can still hold this gap.
    const savedWideGapChain = workflowBounds({
      columns: 1,
      rankGap: 88,
      siblingGap: 0,
    });

    for (const bounds of [narrowChain, wideWorkflow, savedWideGapChain]) {
      const viewport = getViewportForBounds(
        bounds,
        canvas.width,
        canvas.height,
        WORKFLOW_CANVAS_MIN_ZOOM,
        1,
        0.2
      );
      const left = viewport.x + bounds.x * viewport.zoom;
      const top = viewport.y + bounds.y * viewport.zoom;
      const right = viewport.x + (bounds.x + bounds.width) * viewport.zoom;
      const bottom = viewport.y + (bounds.y + bounds.height) * viewport.zoom;

      expect(left).toBeGreaterThan(0);
      expect(top).toBeGreaterThan(0);
      expect(right).toBeLessThan(canvas.width);
      expect(bottom).toBeLessThan(canvas.height);
      expect(
        Math.min(left, top, canvas.width - right, canvas.height - bottom)
      ).toBeGreaterThanOrEqual(26);
    }

    expect(workflowFitViewOptions(0)).toEqual({
      duration: 0,
      maxZoom: 1,
      minZoom: WORKFLOW_CANVAS_MIN_ZOOM,
      padding: 0.2,
    });
  });

  it("keeps the lifecycle at top center when the whole graph remains visible", () => {
    expect(
      initialWorkflowViewport({
        canvas: { height: 800, width: 1000 },
        graphBounds: { height: 300, width: 400, x: 200, y: 80 },
        lifecycle: {
          nodePosition: { x: 200, y: 80 },
          nodeWidth: 192,
          top: 48,
        },
        fittedViewport: { x: 100, y: 80, zoom: 1 },
      })
    ).toEqual({ x: 204, y: -32, zoom: 1 });
  });

  it("keeps the centered fit for a graph that would overflow after anchoring", () => {
    const fittedViewport = { x: 20, y: 10, zoom: 0.1 };

    expect(
      initialWorkflowViewport({
        canvas: { height: 800, width: 1000 },
        graphBounds: { height: 8_912, width: 192, x: 200, y: 80 },
        lifecycle: {
          nodePosition: { x: 200, y: 80 },
          nodeWidth: 192,
          top: 48,
        },
        fittedViewport,
      })
    ).toBe(fittedViewport);
  });

  it("repositions resolved graphs at their incoming Lifecycle coordinates", () => {
    const firstLifecycle = { x: 800, y: 120 };
    const secondLifecycle = { x: 1_600, y: 120 };
    const first = presentationViewport({
      canvas: { height: 800, width: 1000 },
      currentViewport: { x: 100, y: 50, zoom: 0.5 },
      graphBounds: getNodesBounds([
        {
          id: "lifecycle",
          data: {},
          initialHeight: 112,
          initialWidth: 192,
          position: firstLifecycle,
        },
      ]),
      lifecycle: { nodePosition: firstLifecycle, nodeWidth: 192, top: 48 },
    });
    const second = presentationViewport({
      canvas: { height: 800, width: 1000 },
      currentViewport: { x: 100, y: 50, zoom: 0.5 },
      graphBounds: getNodesBounds([
        {
          id: "lifecycle",
          data: {},
          initialHeight: 112,
          initialWidth: 192,
          position: secondLifecycle,
        },
      ]),
      lifecycle: { nodePosition: secondLifecycle, nodeWidth: 192, top: 48 },
    });

    expect(first).toEqual({ x: 52, y: -12, zoom: 0.5 });
    expect(second).toEqual({ x: -348, y: -12, zoom: 0.5 });
  });

  it("centers an incoming presentation that would clip at the lifecycle anchor", () => {
    expect(
      presentationViewport({
        canvas: { height: 800, width: 1000 },
        currentViewport: { x: 100, y: 50, zoom: 0.5 },
        graphBounds: getNodesBounds([
          {
            id: "lifecycle",
            data: {},
            initialHeight: 112,
            initialWidth: 192,
            position: { x: 800, y: 120 },
          },
          {
            id: "terminal",
            data: {},
            initialHeight: 112,
            initialWidth: 192,
            position: { x: 1_608, y: 2_008 },
          },
        ]),
        lifecycle: {
          nodePosition: { x: 800, y: 120 },
          nodeWidth: 192,
          top: 48,
        },
      })
    ).toEqual({ x: -150, y: -160, zoom: 0.5 });
  });

  it("uses one discrete overview presentation for zoomed-out graphs", () => {
    expect(workflowZoomPresentation(0.5)).toBe("overview");
    expect(workflowZoomPresentation(0.51)).toBe("detail");
  });
});
