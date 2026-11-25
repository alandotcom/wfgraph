import { describe, expect, it } from "vitest";
import {
  MIN_USABLE_SIZE,
  usableAboveSheet,
  usableCanvasRect,
} from "./reveal-geometry";
import { revealViewport } from "#src/components/workflow/workflow-viewport";

describe("usableCanvasRect", () => {
  const canvas = { width: 1200, height: 800 };

  it("excludes the width the review sheet covers at the right", () => {
    expect(
      usableCanvasRect({ canvas, rightOccupiedWidth: 388, obstacles: [] })
    ).toEqual({ x: 0, y: 0, width: 1200 - 388, height: 800 });
    expect(
      usableCanvasRect({ canvas, rightOccupiedWidth: 0, obstacles: [] })
    ).toEqual({ x: 0, y: 0, ...canvas });
  });

  it("trims the side of an overlapping obstacle that keeps the most area", () => {
    const controls = { x: 16, y: 600, width: 40, height: 180 };
    expect(
      usableCanvasRect({
        canvas,
        rightOccupiedWidth: 388,
        obstacles: [controls],
      })
    ).toEqual({ x: 56, y: 0, width: 812 - 56, height: 800 });
  });

  it("ignores an obstacle outside the usable part or one every trim ruins", () => {
    const underReveal = { x: 1000, y: 100, width: 100, height: 100 };
    const covering = { x: 10, y: 10, width: 790, height: 780 };
    expect(
      usableCanvasRect({
        canvas,
        rightOccupiedWidth: 388,
        obstacles: [underReveal, covering],
      })
    ).toEqual({ x: 0, y: 0, width: 812, height: 800 });
  });

  it("answers null when the sheet leaves less than the minimum", () => {
    expect(
      usableCanvasRect({
        canvas: { width: 900, height: 700 },
        rightOccupiedWidth: 892,
        obstacles: [],
      })
    ).toBeNull();
    expect(MIN_USABLE_SIZE.width).toBeGreaterThan(0);
  });
});

describe("usableAboveSheet", () => {
  const canvas = { width: 390, height: 700 };

  it("places a node near the bottom above the summary sheet's top edge", () => {
    const sheetTop = 420;
    const usable = usableAboveSheet({ canvas, sheetTop, obstacles: [] });
    expect(usable).toEqual({ x: 0, y: 0, width: 390, height: sheetTop });

    const bounds = { x: 100, y: 600, width: 200, height: 80 };
    const viewport = revealViewport({
      viewport: { x: 0, y: 0, zoom: 1 },
      usable: usable ?? { x: 0, y: 0, ...canvas },
      bounds,
    });
    const top = viewport.y + bounds.y * viewport.zoom;
    const bottom = viewport.y + (bounds.y + bounds.height) * viewport.zoom;
    expect(viewport.zoom).toBe(1);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(sheetTop);
  });

  it("answers null when the sheet leaves too little canvas above it", () => {
    expect(
      usableAboveSheet({ canvas, sheetTop: 60, obstacles: [] })
    ).toBeNull();
  });
});
