import { getNodesBounds, getViewportForBounds } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_CANVAS_MIN_ZOOM,
  initialWorkflowViewport,
  presentationViewport,
  revealViewport,
  viewportFromWorldCamera,
  workflowFitViewOptions,
  workflowZoomPresentation,
  worldCameraFromViewport,
} from "#src/components/workflow/workflow-viewport";

describe("workspace camera", () => {
  it("restores the same world-space center on a canvas of another size", () => {
    const desktopCanvas = { width: 1200, height: 800 };
    const camera = worldCameraFromViewport(
      { x: -300, y: 40, zoom: 0.5 },
      desktopCanvas
    );

    expect(camera).toEqual({ centerX: 1800, centerY: 720, zoom: 0.5 });
    expect(viewportFromWorldCamera(camera, desktopCanvas)).toEqual({
      x: -300,
      y: 40,
      zoom: 0.5,
    });

    // A phone-width canvas keeps the same flow point in its middle.
    const phoneCanvas = { width: 390, height: 640 };
    const phoneViewport = viewportFromWorldCamera(camera, phoneCanvas);
    expect(worldCameraFromViewport(phoneViewport, phoneCanvas)).toEqual(camera);
  });
});

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

describe("revealViewport", () => {
  const usable = { x: 0, y: 0, width: 812, height: 800 };
  const step = { x: 0, y: 0, width: 192, height: 112 };

  it("keeps the viewport when the step already sits inside the usable part", () => {
    const viewport = { x: 200, y: 200, zoom: 1 };
    expect(revealViewport({ viewport, usable, bounds: step })).toBe(viewport);
  });

  it("moves the least distance along one axis and keeps the zoom", () => {
    // The step sits under Reveal, 900 to 1092 px across a 1200 px canvas.
    const viewport = { x: 900, y: 300, zoom: 1 };
    const next = revealViewport({ viewport, usable, bounds: step });
    // Right edge plus 64 px of context lands on the padded edge at 788.
    expect(next).toEqual({ x: 788 - 64 - 192, y: 300, zoom: 1 });
  });

  it("decreases the zoom only enough to fit, about the step's center", () => {
    const wide = { x: 0, y: 0, width: 1600, height: 112 };
    const viewport = { x: 0, y: 300, zoom: 1 };
    const next = revealViewport({ viewport, usable, bounds: wide });
    expect(next.zoom).toBeCloseTo((812 - 48) / 1600, 6);
    expect(next.x).toBeCloseTo(24, 6);
    expect(next.zoom).toBeLessThan(viewport.zoom);
  });

  it("never zooms in on a step smaller than the usable part", () => {
    const viewport = { x: 900, y: 300, zoom: 0.4 };
    expect(revealViewport({ viewport, usable, bounds: step }).zoom).toBe(0.4);
  });

  it("keeps a long horizontal workflow's direction and neighbors", () => {
    // A step deep in a left-to-right chain, hidden by Reveal: the chain moves
    // left, the zoom holds, and the 64 px left of the step stays on screen.
    const deep = { x: 4000, y: 0, width: 192, height: 112 };
    const viewport = { x: -3200, y: 300, zoom: 1 };
    const next = revealViewport({ viewport, usable, bounds: deep });
    expect(next.y).toBe(300);
    expect(next.zoom).toBe(1);
    const left = next.x + deep.x;
    expect(left).toBe(788 - 64 - 192);
    expect(left - 64).toBeGreaterThan(24);
  });

  it("keeps a long vertical workflow's direction and neighbors", () => {
    const low = { x: 0, y: 5000, width: 192, height: 112 };
    const viewport = { x: 200, y: -4400, zoom: 1 };
    const next = revealViewport({ viewport, usable, bounds: low });
    expect(next.x).toBe(200);
    expect(next.y + low.y + low.height + 64).toBe(800 - 24);
  });

  it("drops the context padding when the context would not fit", () => {
    const tall = { x: 0, y: 0, width: 192, height: 700 };
    const viewport = { x: 900, y: 50, zoom: 1 };
    const next = revealViewport({ viewport, usable, bounds: tall });
    expect(next).toEqual({ x: 788 - 192, y: 50, zoom: 1 });
  });
});
