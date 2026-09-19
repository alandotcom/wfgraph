import { describe, expect, it } from "vitest";
import {
  MIN_USABLE_SIZE,
  REVEAL_INSET,
  revealOccupiedWidth,
  revealWidth,
  revealWidthRange,
  usableAboveSheet,
  usableCanvasRect,
} from "./reveal-geometry";
import { revealViewport } from "#src/components/workflow/workflow-viewport";

/** No width a person chose, so every level uses its default. */
const NONE = undefined;

describe("revealWidth", () => {
  it.each([
    { canvas: 900, expected: 640 },
    { canvas: 1100, expected: 640 },
    { canvas: 1400, expected: 720 },
    { canvas: 1800, expected: 800 },
  ])(
    "keeps every open level at the same width on a $canvas px canvas",
    ({ canvas, expected }) => {
      expect(revealWidth("closed", canvas, NONE)).toBe(0);
      expect(revealWidth("browse", canvas, NONE)).toBe(expected);
      expect(revealWidth("focus", canvas, NONE)).toBe(expected);
    }
  );

  it("leaves at least 256 px of canvas from 1024 px", () => {
    for (const canvas of [1024, 1100, 1280, 1536, 1800]) {
      expect(
        canvas - revealOccupiedWidth("focus", canvas, NONE)
      ).toBeGreaterThanOrEqual(256);
    }
  });

  it("stays within a canvas narrower than Reveal", () => {
    expect(revealWidth("browse", 300, NONE)).toBe(300 - 2 * REVEAL_INSET);
    expect(revealWidth("focus", 600, NONE)).toBe(600 - 2 * REVEAL_INSET);
  });
});

describe("revealWidth with a remembered width", () => {
  it("gives Reveal a range from its minimum to 256 px short of the canvas", () => {
    expect(revealWidthRange(1024)).toEqual({
      min: 480,
      max: 1024 - 256 - REVEAL_INSET,
      defaultWidth: 640,
    });
    expect(revealWidthRange(1440)).toEqual({
      min: 480,
      max: 1440 - 256 - REVEAL_INSET,
      defaultWidth: 720,
    });
    expect(revealWidthRange(1023)).toBeNull();
  });

  it("uses one remembered width for every open level", () => {
    expect(revealWidth("browse", 1440, 600)).toBe(600);
    expect(revealWidth("focus", 1440, 600)).toBe(600);
    expect(revealOccupiedWidth("focus", 1440, 600)).toBe(600 + REVEAL_INSET);
  });

  it("clamps a remembered width to the current canvas each time it is read", () => {
    expect(revealWidth("browse", 1440, 1400)).toBe(1440 - 256 - REVEAL_INSET);
    expect(revealWidth("browse", 1100, 1400)).toBe(1100 - 256 - REVEAL_INSET);
    expect(revealWidth("focus", 1440, 200)).toBe(480);
    expect(revealWidth("closed", 1440, 200)).toBe(0);
  });

  it("ignores a remembered width on a canvas narrower than 1024 px", () => {
    expect(revealWidth("browse", 900, 500)).toBe(640);
    expect(revealWidth("focus", 900, 500)).toBe(640);
  });
});

describe("usableCanvasRect", () => {
  const canvas = { width: 1200, height: 800 };

  it("excludes Reveal and its inset from the right", () => {
    expect(
      usableCanvasRect({
        canvas,
        revealOccupiedWidth: 380 + REVEAL_INSET,
        obstacles: [],
      })
    ).toEqual({ x: 0, y: 0, width: 1200 - 380 - REVEAL_INSET, height: 800 });
    expect(
      usableCanvasRect({ canvas, revealOccupiedWidth: 0, obstacles: [] })
    ).toEqual({ x: 0, y: 0, ...canvas });
  });

  it("trims the side of an overlapping obstacle that keeps the most area", () => {
    const controls = { x: 16, y: 600, width: 40, height: 180 };
    expect(
      usableCanvasRect({
        canvas,
        revealOccupiedWidth: 380 + REVEAL_INSET,
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
        revealOccupiedWidth: 380 + REVEAL_INSET,
        obstacles: [underReveal, covering],
      })
    ).toEqual({ x: 0, y: 0, width: 812, height: 800 });
  });

  it("leaves a place for a step beside Focus on a 900px canvas", () => {
    expect(
      usableCanvasRect({
        canvas: { width: 900, height: 700 },
        revealOccupiedWidth: revealOccupiedWidth("focus", 900, NONE),
        obstacles: [],
      })
    ).toEqual({ x: 0, y: 0, width: 900 - 640 - REVEAL_INSET, height: 700 });
  });

  it("answers null when Reveal leaves less than the minimum", () => {
    expect(
      usableCanvasRect({
        canvas: { width: 900, height: 700 },
        revealOccupiedWidth: 900 - REVEAL_INSET,
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
