/**
 * Canvas Reveal's fixed geometry and the part of the canvas it leaves usable.
 * All values are CSS pixels measured inside the canvas box. One `revealWidth`
 * feeds both the rendered width and the camera, so the two always agree.
 */

import { maxBy } from "es-toolkit/array";
import type { RevealLevel } from "#src/lib/workflow-navigation-state";

export type Rect = { x: number; y: number; width: number; height: number };

/** The gap between Canvas Reveal and each edge of the canvas box. */
export const REVEAL_INSET = 8;

/** Screen pixels between a placed step and the edge of the usable rectangle. */
export const REVEAL_PADDING_PX = 24;

/** Screen pixels of neighboring canvas kept around a step Reveal places. */
export const REVEAL_CONTEXT_PX = 64;

/**
 * The `data-slot` values of the elements floating over the canvas that a placed
 * step must stay clear of. The elements carry them and the camera measures them.
 */
export const CANVAS_OBSTACLE_SLOTS = {
  controls: "workflow-canvas-controls",
  agentPanel: "agent-panel",
  groupScopeBar: "group-scope-bar",
} as const;

/** The canvas width Focus and its inset leave beside them at 1024px and wider. */
const FOCUS_CANVAS_MARGIN = 256;

/** Focus's widest size on a canvas narrower than 1024px. */
const NARROW_FOCUS_WIDTH = 640;

/** The smallest rectangle worth placing a selected step in. */
export const MIN_USABLE_SIZE = { width: 240, height: 160 } as const;

/** The smallest rectangle above a mobile summary sheet worth placing a step in. */
const MOBILE_MIN_USABLE_SIZE = { width: 200, height: 120 } as const;

/**
 * How wide a subject kind's Focus is. Standard fits one form column. Wide adds
 * 200px for an editor that pairs a section list with its form, such as the
 * Lifecycle policy editor.
 */
export type RevealFocusWidth = "standard" | "wide";

/** The Browse and Focus widths at 1024px, 1280px, and 1536px canvas widths. */
const WIDTH_STEPS = [
  { minCanvas: 1536, browse: 400, standard: 800, wide: 1000 },
  { minCanvas: 1280, browse: 380, standard: 720, wide: 920 },
  { minCanvas: 1024, browse: 360, standard: 640, wide: 840 },
] as const;

/**
 * The width of Canvas Reveal at one level on a canvas box of `canvasWidth`.
 * Below 1024px a standard Focus is at most 640px, so part of the canvas stays
 * visible beside it, and a wide Focus covers the canvas. Wider boxes step
 * through three sizes, and Focus is narrowed where needed to leave 256px of
 * canvas beside its inset.
 */
export function revealWidth(
  level: RevealLevel,
  canvasWidth: number,
  focusWidth: RevealFocusWidth
): number {
  if (level === "closed") {
    return 0;
  }
  const available = Math.max(0, canvasWidth - 2 * REVEAL_INSET);
  const step = WIDTH_STEPS.find((entry) => canvasWidth >= entry.minCanvas);
  if (!step) {
    if (level === "browse") {
      return Math.min(320, available);
    }
    return focusWidth === "wide"
      ? available
      : Math.min(NARROW_FOCUS_WIDTH, available);
  }
  return level === "browse"
    ? step.browse
    : Math.min(
        step[focusWidth],
        canvasWidth - FOCUS_CANVAS_MARGIN - REVEAL_INSET
      );
}

/**
 * The width Canvas Reveal takes from the right of the canvas box at one level:
 * its own width and the inset beside it, or 0 while closed.
 */
export function revealOccupiedWidth(
  level: RevealLevel,
  canvasWidth: number,
  focusWidth: RevealFocusWidth
): number {
  const width = revealWidth(level, canvasWidth, focusWidth);
  return width > 0 ? width + REVEAL_INSET : 0;
}

function area(rect: Rect): number {
  return rect.width * rect.height;
}

function intersects(left: Rect, right: Rect): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

function fits(rect: Rect, minSize: { width: number; height: number }): boolean {
  return rect.width >= minSize.width && rect.height >= minSize.height;
}

/** The four rectangles left after trimming `rect` past one side of `obstacle`. */
function trims(rect: Rect, obstacle: Rect): Rect[] {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const obstacleRight = obstacle.x + obstacle.width;
  const obstacleBottom = obstacle.y + obstacle.height;
  return [
    { ...rect, x: obstacleRight, width: right - obstacleRight },
    { ...rect, width: obstacle.x - rect.x },
    { ...rect, y: obstacleBottom, height: bottom - obstacleBottom },
    { ...rect, height: obstacle.y - rect.y },
  ];
}

/**
 * The part of the canvas a selected step may be placed in: the canvas less
 * Canvas Reveal on the right, less each obstacle that overlaps it. An obstacle
 * trims the side that keeps the most area, and is ignored when every trim would
 * leave less than `minSize`. Null when Reveal leaves less than `minSize`.
 */
export function usableCanvasRect(input: {
  canvas: { width: number; height: number };
  /** The width Canvas Reveal takes from the right, from `revealOccupiedWidth`. */
  revealOccupiedWidth: number;
  obstacles: readonly Rect[];
  minSize?: { width: number; height: number } | undefined;
}): Rect | null {
  const minSize = input.minSize ?? MIN_USABLE_SIZE;
  let usable: Rect = {
    x: 0,
    y: 0,
    width: input.canvas.width - input.revealOccupiedWidth,
    height: input.canvas.height,
  };
  if (!fits(usable, minSize)) {
    return null;
  }
  for (const obstacle of input.obstacles) {
    if (!intersects(usable, obstacle)) {
      continue;
    }
    const best = maxBy(
      trims(usable, obstacle).filter((trimmed) => fits(trimmed, minSize)),
      area
    );
    if (best) {
      usable = best;
    }
  }
  return usable;
}

/**
 * The part of the canvas a mobile summary sheet leaves for placing its subject:
 * the canvas above `sheetTop`, the sheet's top edge measured from the canvas
 * top, less each other obstacle as `usableCanvasRect` trims it. Null when the
 * sheet leaves less than `minSize`.
 */
export function usableAboveSheet(input: {
  canvas: { width: number; height: number };
  sheetTop: number;
  obstacles: readonly Rect[];
  minSize?: { width: number; height: number } | undefined;
}): Rect | null {
  const sheet: Rect = {
    x: 0,
    y: input.sheetTop,
    width: input.canvas.width,
    height: Math.max(0, input.canvas.height - input.sheetTop),
  };
  const minSize = input.minSize ?? MOBILE_MIN_USABLE_SIZE;
  if (input.sheetTop < minSize.height) {
    return null;
  }
  return usableCanvasRect({
    canvas: input.canvas,
    revealOccupiedWidth: 0,
    obstacles: [sheet, ...input.obstacles],
    minSize,
  });
}
