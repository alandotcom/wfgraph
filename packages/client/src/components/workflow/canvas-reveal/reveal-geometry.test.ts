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
const NONE = {};

describe("revealWidth", () => {
  it.each([
    { canvas: 900, browse: 320, focus: 640 },
    { canvas: 1100, browse: 360, focus: 640 },
    { canvas: 1400, browse: 380, focus: 720 },
    { canvas: 1800, browse: 400, focus: 800 },
  ])(
    "gives a $canvas px canvas fixed Browse and Focus widths",
    ({ canvas, browse, focus }) => {
      expect(revealWidth("closed", canvas, "standard", NONE)).toBe(0);
      expect(revealWidth("browse", canvas, "standard", NONE)).toBe(browse);
      expect(revealWidth("focus", canvas, "standard", NONE)).toBe(focus);
    }
  );

  it("keeps a standard Focus beside at least 256 px of canvas from 1024 px", () => {
    expect(revealWidth("focus", 1024, "standard", NONE)).toBe(640);
    expect(revealWidth("focus", 1290, "standard", NONE)).toBe(720);
    expect(revealWidth("focus", 1536, "standard", NONE)).toBe(800);
    expect(revealWidth("focus", 1030, "standard", NONE)).toBe(640);
    expect(revealWidth("focus", 1000, "standard", NONE)).toBe(640);
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
      expect(revealWidth("focus", canvas, "wide", NONE)).toBe(wide);
      expect(revealWidth("browse", canvas, "wide", NONE)).toBe(
        revealWidth("browse", canvas, "standard", NONE)
      );
      expect(revealOccupiedWidth("focus", canvas, "wide", NONE)).toBe(
        wide + REVEAL_INSET
      );
    }
  );

  it("leaves 256 px of canvas beside a wide Focus and its inset", () => {
    for (const canvas of [1024, 1100, 1280, 1536, 1800]) {
      expect(
        canvas - revealOccupiedWidth("focus", canvas, "wide", NONE)
      ).toBeGreaterThanOrEqual(256);
    }
  });

  it("stays within a canvas narrower than Browse or Focus", () => {
    expect(revealWidth("browse", 300, "standard", NONE)).toBe(
      300 - 2 * REVEAL_INSET
    );
    expect(revealWidth("focus", 600, "standard", NONE)).toBe(
      600 - 2 * REVEAL_INSET
    );
  });
});

describe("revealWidth with remembered widths", () => {
  it("gives each key a range from its minimum to 256 px of canvas short of the canvas", () => {
    expect(revealWidthRange("browse", 1024)).toEqual({
      min: 320,
      max: 1024 - 256 - REVEAL_INSET,
      defaultWidth: 360,
    });
    expect(revealWidthRange("standard", 1440)).toEqual({
      min: 480,
      max: 1440 - 256 - REVEAL_INSET,
      defaultWidth: 720,
    });
    expect(revealWidthRange("wide", 1100)).toEqual({
      min: 480,
      max: 1100 - 256 - REVEAL_INSET,
      defaultWidth: 1100 - 256 - REVEAL_INSET,
    });
    expect(revealWidthRange("browse", 1023)).toBeNull();
  });

  it("uses the width remembered for the level and its Focus width", () => {
    const remembered = { browse: 500, standard: 600, wide: 900 };
    expect(revealWidth("browse", 1440, "standard", remembered)).toBe(500);
    expect(revealWidth("focus", 1440, "standard", remembered)).toBe(600);
    expect(revealWidth("focus", 1440, "wide", remembered)).toBe(900);
    expect(revealWidth("browse", 1440, "wide", { standard: 600 })).toBe(380);
    expect(revealOccupiedWidth("focus", 1440, "standard", remembered)).toBe(
      600 + REVEAL_INSET
    );
  });

  it("clamps a remembered width to the current canvas each time it is read", () => {
    const remembered = { browse: 1400, standard: 200 };
    expect(revealWidth("browse", 1440, "standard", remembered)).toBe(
      1440 - 256 - REVEAL_INSET
    );
    expect(revealWidth("browse", 1100, "standard", remembered)).toBe(
      1100 - 256 - REVEAL_INSET
    );
    expect(revealWidth("focus", 1440, "standard", remembered)).toBe(480);
    expect(revealWidth("closed", 1440, "standard", remembered)).toBe(0);
  });

  it("ignores remembered widths on a canvas narrower than 1024 px", () => {
    const remembered = { browse: 500, standard: 520, wide: 600 };
    expect(revealWidth("browse", 900, "standard", remembered)).toBe(320);
    expect(revealWidth("focus", 900, "standard", remembered)).toBe(640);
    expect(revealWidth("focus", 900, "wide", remembered)).toBe(
      900 - 2 * REVEAL_INSET
    );
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
        revealOccupiedWidth: revealOccupiedWidth(
          "focus",
          900,
          "standard",
          NONE
        ),
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
