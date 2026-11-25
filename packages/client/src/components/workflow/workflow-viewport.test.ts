import { getNodesBounds, getViewportForBounds } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_CANVAS_MIN_ZOOM,
  WORKFLOW_COMPACT_CARD_ZOOM,
  WORKFLOW_NUMBER_CARD_ZOOM,
  WORKFLOW_FIT_VIEW_MAX_ZOOM,
  WORKFLOW_FIT_VIEW_PADDING,
  cardTierAtZoom,
  openingViewport,
  revealViewport,
  viewportFromWorldCamera,
  workflowFitViewOptions,
  worldCameraFromViewport,
} from "#src/components/workflow/workflow-viewport";
import { COMPACT_TITLE_MIN_PX } from "#src/components/flow-elements/compact-card";

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

  it("anchors the Lifecycle at the top center when the fitted graph shows whole", () => {
    expect(
      openingViewport({
        usable: { x: 0, y: 0, width: 1000, height: 800 },
        graphBounds: { height: 300, width: 400, x: 200, y: 80 },
        lifecycle: { nodePosition: { x: 200, y: 80 }, nodeWidth: 192 },
        zoomLimit: WORKFLOW_FIT_VIEW_MAX_ZOOM,
      })
    ).toEqual({ x: 204, y: -32, zoom: 1 });
  });

  it("opens a large graph fitted whole, at the zoom Fit view chooses, when every card keeps its title there", () => {
    // A graph wider than the canvas between the outline and the details
    // column, which Fit view fits at about 0.56, above the compact tier's
    // lowest zoom.
    const usable = { x: 0, y: 0, width: 700, height: 798 };
    const graphBounds = { x: 0, y: 0, width: 1050, height: 1000 };
    const viewport = openingViewport({
      usable,
      graphBounds,
      lifecycle: { nodePosition: { x: 429, y: 0 }, nodeWidth: 192 },
      zoomLimit: WORKFLOW_FIT_VIEW_MAX_ZOOM,
    });

    const fitView = getViewportForBounds(
      graphBounds,
      usable.width,
      usable.height,
      WORKFLOW_CANVAS_MIN_ZOOM,
      WORKFLOW_FIT_VIEW_MAX_ZOOM,
      WORKFLOW_FIT_VIEW_PADDING
    );
    expect(viewport.zoom).toBe(fitView.zoom);
    expect(viewport.zoom).toBeLessThan(1);
    expect(cardTierAtZoom(viewport.zoom)).toBe("compact");
    // Every card is on screen.
    expect(viewport.x + graphBounds.x * viewport.zoom).toBeGreaterThanOrEqual(
      0
    );
    expect(viewport.y + graphBounds.y * viewport.zoom).toBeGreaterThanOrEqual(
      0
    );
    expect(
      viewport.x + (graphBounds.x + graphBounds.width) * viewport.zoom
    ).toBeLessThanOrEqual(usable.width);
    expect(
      viewport.y + (graphBounds.y + graphBounds.height) * viewport.zoom
    ).toBeLessThanOrEqual(usable.height);
  });

  it("opens a small graph at zoom 1 rather than blowing it up", () => {
    const viewport = openingViewport({
      usable: { x: 0, y: 0, width: 1000, height: 800 },
      graphBounds: { x: 0, y: 0, width: 192, height: 292 },
      lifecycle: { nodePosition: { x: 0, y: 0 }, nodeWidth: 192 },
      zoomLimit: WORKFLOW_FIT_VIEW_MAX_ZOOM,
    });

    expect(viewport.zoom).toBe(1);
  });

  it("anchors inside the usable canvas Canvas Reveal and the controls leave", () => {
    expect(
      openingViewport({
        usable: { x: 40, y: 10, width: 600, height: 700 },
        graphBounds: { height: 112, width: 192, x: 200, y: 80 },
        lifecycle: { nodePosition: { x: 200, y: 80 }, nodeWidth: 192 },
        zoomLimit: WORKFLOW_FIT_VIEW_MAX_ZOOM,
      })
    ).toEqual({ x: 44, y: -22, zoom: 1 });
  });

  it("keeps a lower zoom limit and repositions graphs at their incoming Lifecycle coordinates", () => {
    const usable = { x: 0, y: 0, width: 1000, height: 800 };
    const placedAt = (position: { x: number; y: number }) =>
      openingViewport({
        usable,
        graphBounds: getNodesBounds([
          {
            id: "lifecycle",
            data: {},
            initialHeight: 112,
            initialWidth: 192,
            position,
          },
        ]),
        lifecycle: { nodePosition: position, nodeWidth: 192 },
        zoomLimit: 0.5,
      });

    expect(placedAt({ x: 800, y: 120 })).toEqual({ x: 52, y: -12, zoom: 0.5 });
    expect(placedAt({ x: 1_600, y: 120 })).toEqual({
      x: -348,
      y: -12,
      zoom: 0.5,
    });
  });

  it("centers a graph that fits but would clip at the Lifecycle anchor", () => {
    expect(
      openingViewport({
        usable: { x: 0, y: 0, width: 1000, height: 800 },
        graphBounds: { x: 0, y: 0, width: 1_592, height: 212 },
        lifecycle: { nodePosition: { x: 0, y: 0 }, nodeWidth: 192 },
        zoomLimit: 0.5,
      })
    ).toEqual({ x: 102, y: 347, zoom: 0.5 });
  });

  it("keeps the Lifecycle anchor for a graph too large to fit at the compact tier, which runs off the bottom edge", () => {
    expect(
      openingViewport({
        usable: { x: 0, y: 0, width: 1000, height: 800 },
        graphBounds: { height: 40_000, width: 192, x: 200, y: 80 },
        lifecycle: { nodePosition: { x: 200, y: 80 }, nodeWidth: 192 },
        zoomLimit: WORKFLOW_FIT_VIEW_MAX_ZOOM,
      })
    ).toEqual({
      x: 500 - 296 * WORKFLOW_NUMBER_CARD_ZOOM,
      y: 48 - 80 * WORKFLOW_NUMBER_CARD_ZOOM,
      zoom: WORKFLOW_NUMBER_CARD_ZOOM,
    });
  });

  it("draws cards in three tiers: full where its 12px text reads at 12px, compact while a 21px title reads at 11px", () => {
    // The full card's 12px description draws at 12px or more.
    expect(12 * WORKFLOW_COMPACT_CARD_ZOOM).toBeGreaterThanOrEqual(12);
    expect(COMPACT_TITLE_MIN_PX * WORKFLOW_NUMBER_CARD_ZOOM).toBeCloseTo(11);
    expect(cardTierAtZoom(1)).toBe("full");
    expect(cardTierAtZoom(WORKFLOW_COMPACT_CARD_ZOOM)).toBe("full");
    expect(cardTierAtZoom(WORKFLOW_COMPACT_CARD_ZOOM - 0.01)).toBe("compact");
    expect(cardTierAtZoom(WORKFLOW_NUMBER_CARD_ZOOM)).toBe("compact");
    expect(cardTierAtZoom(WORKFLOW_NUMBER_CARD_ZOOM - 0.01)).toBe("number");
    expect(cardTierAtZoom(WORKFLOW_CANVAS_MIN_ZOOM)).toBe("number");
  });

  it("opens the seeded 16-step workflow on titled cards, with the Lifecycle card at the top centre", () => {
    // The canvas between the outline and the details column of a 1512 by 982
    // window, where the 16-step workflow with its Group drawn in place fits
    // whole only at about 0.37, which would draw every card by number alone.
    const usable = { x: 0, y: 0, width: 770, height: 872 };
    const viewport = openingViewport({
      usable,
      graphBounds: { x: 0, y: 0, width: 1050, height: 1960 },
      lifecycle: { nodePosition: { x: 429, y: 0 }, nodeWidth: 192 },
      zoomLimit: WORKFLOW_FIT_VIEW_MAX_ZOOM,
    });

    expect(viewport.zoom).toBe(WORKFLOW_NUMBER_CARD_ZOOM);
    expect(cardTierAtZoom(viewport.zoom)).toBe("compact");
    // The Lifecycle card's centre sits at the canvas's centre, 48px down.
    expect(viewport.x + (429 + 96) * viewport.zoom).toBeCloseTo(385);
    expect(viewport.y).toBe(48);
  });

  it("keeps a lower zoom a person chose when a view changes", () => {
    const viewport = openingViewport({
      usable: { x: 0, y: 0, width: 770, height: 872 },
      graphBounds: { x: 0, y: 0, width: 1050, height: 1960 },
      lifecycle: { nodePosition: { x: 429, y: 0 }, nodeWidth: 192 },
      zoomLimit: 0.3,
    });

    expect(viewport.zoom).toBe(0.3);
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

  it("places an optional box with the step when the two fit together", () => {
    // The label below the step ends 524 px down, 724 px on screen. With 64 px
    // of context that passes the padded bottom edge at 776 by 12 px.
    const label = { x: 0, y: 500, width: 56, height: 24 };
    const viewport = { x: 200, y: 200, zoom: 1 };
    const next = revealViewport({
      viewport,
      usable,
      bounds: step,
      optionalBounds: [label],
    });
    expect(next).toEqual({ x: 200, y: 188, zoom: 1 });
  });

  it("leaves out an optional box that would not fit at the step's zoom", () => {
    const farLabel = { x: 0, y: 5000, width: 56, height: 24 };
    const viewport = { x: 200, y: 200, zoom: 1 };
    expect(
      revealViewport({
        viewport,
        usable,
        bounds: step,
        optionalBounds: [farLabel],
      })
    ).toBe(viewport);
  });
});

describe("workflowFitViewOptions and the agent's prompt line", () => {
  function rect(top: number, bottom: number): DOMRect {
    return {
      top,
      bottom,
      left: 0,
      right: 1200,
      width: 1200,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
  }

  it("keeps a fit above the prompt line, and above the row a selection adds to it, while it shows", () => {
    const box = document.createElement("div");
    box.dataset.slot = "canvas-box";
    const line = document.createElement("div");
    line.dataset.slot = "agent-composer";
    box.append(line);
    document.body.append(box);
    box.getBoundingClientRect = () => rect(0, 800);
    line.getBoundingClientRect = () => rect(736, 788);
    line.getClientRects = () => [rect(736, 788)] as unknown as DOMRectList;
    try {
      expect(workflowFitViewOptions(0).padding).toEqual({
        top: WORKFLOW_FIT_VIEW_PADDING,
        left: WORKFLOW_FIT_VIEW_PADDING,
        right: WORKFLOW_FIT_VIEW_PADDING,
        // 64px of prompt line, the 24px row a selected step adds above it,
        // and 24px of room.
        bottom: "112px",
      });
    } finally {
      box.remove();
    }
    expect(workflowFitViewOptions(0).padding).toBe(WORKFLOW_FIT_VIEW_PADDING);
  });
});
