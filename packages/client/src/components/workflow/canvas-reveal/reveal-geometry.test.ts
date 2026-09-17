import { describe, expect, it } from "vitest";
import {
  MIN_USABLE_SIZE,
  REVEAL_INSET,
  revealOccupiedWidth,
  revealWidth,
  usableCanvasRect,
} from "./reveal-geometry";

describe("revealWidth", () => {
  it.each([
    { canvas: 900, browse: 320, focus: 640 },
    { canvas: 1100, browse: 360, focus: 640 },
    { canvas: 1400, browse: 380, focus: 720 },
    { canvas: 1800, browse: 400, focus: 800 },
  ])(
    "gives a $canvas px canvas fixed Browse and Focus widths",
    ({ canvas, browse, focus }) => {
      expect(revealWidth("closed", canvas, "standard")).toBe(0);
      expect(revealWidth("browse", canvas, "standard")).toBe(browse);
      expect(revealWidth("focus", canvas, "standard")).toBe(focus);
    }
  );

  it("keeps a standard Focus beside at least 256 px of canvas from 1024 px", () => {
    expect(revealWidth("focus", 1024, "standard")).toBe(640);
    expect(revealWidth("focus", 1290, "standard")).toBe(720);
    expect(revealWidth("focus", 1536, "standard")).toBe(800);
    expect(revealWidth("focus", 1030, "standard")).toBe(640);
    expect(revealWidth("focus", 1000, "standard")).toBe(640);
  });

  it.each([
    { canvas: 900, wide: 900 - 2 * REVEAL_INSET },
    { canvas: 1024, wide: 1024 - 256 - REVEAL_INSET },
    { canvas: 1100, wide: 1100 - 256 - REVEAL_INSET },
    { canvas: 1200, wide: 840 },
    { canvas: 1400, wide: 920 },
    { canvas: 1800, wide: 1000 },
  ])(
    "gives a $canvas px canvas a wide Focus of up to its step width",
    ({ canvas, wide }) => {
      expect(revealWidth("focus", canvas, "wide")).toBe(wide);
      expect(revealWidth("browse", canvas, "wide")).toBe(
        revealWidth("browse", canvas, "standard")
      );
      expect(revealOccupiedWidth("focus", canvas, "wide")).toBe(
        wide + REVEAL_INSET
      );
    }
  );

  it("leaves 256 px of canvas beside a wide Focus and its inset", () => {
    for (const canvas of [1024, 1100, 1280, 1536, 1800]) {
      expect(
        canvas - revealOccupiedWidth("focus", canvas, "wide")
      ).toBeGreaterThanOrEqual(256);
    }
  });

  it("stays within a canvas narrower than Browse or Focus", () => {
    expect(revealWidth("browse", 300, "standard")).toBe(300 - 2 * REVEAL_INSET);
    expect(revealWidth("focus", 600, "standard")).toBe(600 - 2 * REVEAL_INSET);
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
        revealOccupiedWidth: revealOccupiedWidth("focus", 900, "standard"),
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
