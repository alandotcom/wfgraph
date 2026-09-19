/**
 * Canvas Reveal's widths, the part of the canvas it leaves usable, and
 * the boxes a placement measures. All values are CSS pixels measured inside the
 * canvas box, except `subjectBounds`, which answers in flow space. One
 * `revealWidth` feeds both the rendered width and the camera.
 */

import type { ReactFlowInstance } from "@xyflow/react";
import { maxBy } from "es-toolkit/array";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import type { RevealLevel } from "#src/lib/workflow-navigation-state";
import { outletPlacement } from "./reveal-outlets";
import type { RevealPlacement } from "./reveal-subject";

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

/** The canvas width Reveal and its inset leave beside them at 1024px and wider. */
const REVEAL_CANVAS_MARGIN = 256;

/** Reveal's widest size on a canvas narrower than 1024px. */
const NARROW_REVEAL_WIDTH = 640;

/** The smallest rectangle worth placing a selected step in. */
export const MIN_USABLE_SIZE = { width: 240, height: 160 } as const;

/** The smallest rectangle above a mobile summary sheet worth placing a step in. */
const MOBILE_MIN_USABLE_SIZE = { width: 200, height: 120 } as const;

/** The narrowest width a person can resize Canvas Reveal to. */
export const REVEAL_MIN_WIDTH = 480;

/** The default Reveal widths at 1024px, 1280px, and 1536px canvas widths. */
const WIDTH_STEPS = [
  { minCanvas: 1536, width: 800 },
  { minCanvas: 1280, width: 720 },
  { minCanvas: 1024, width: 640 },
] as const;

/**
 * The range a person can resize Canvas Reveal through on a canvas box of
 * `canvasWidth`, and the width it has before any resize. The maximum leaves
 * 256px of canvas beside Reveal and its inset, and the default is the table
 * width, narrowed to that maximum. Null below 1024px, where Reveal keeps a fixed
 * width and shows no resize handle.
 */
export function revealWidthRange(
  canvasWidth: number
): { min: number; max: number; defaultWidth: number } | null {
  // The last step starts at 1024px, so every resizable canvas finds one.
  const step = WIDTH_STEPS.find((entry) => canvasWidth >= entry.minCanvas);
  if (!step) {
    return null;
  }
  const max = Math.max(
    REVEAL_MIN_WIDTH,
    canvasWidth - REVEAL_CANVAS_MARGIN - REVEAL_INSET
  );
  return {
    min: REVEAL_MIN_WIDTH,
    max,
    defaultWidth: Math.min(step.width, max),
  };
}

/** `width` held inside `range`, rounded to a whole pixel. */
export function clampRevealWidth(
  width: number,
  range: { min: number; max: number }
): number {
  return Math.round(Math.min(range.max, Math.max(range.min, width)));
}

/**
 * The width of Canvas Reveal at one level on a canvas box of `canvasWidth`.
 * Every subject and open level uses the same remembered width. Below 1024px
 * Reveal is at most 640px and remembered widths do not apply. From 1024px the
 * remembered or default width is held inside its range.
 */
export function revealWidth(
  level: RevealLevel,
  canvasWidth: number,
  remembered: number | undefined
): number {
  if (level === "closed") {
    return 0;
  }
  const range = revealWidthRange(canvasWidth);
  if (!range) {
    return Math.min(
      NARROW_REVEAL_WIDTH,
      Math.max(0, canvasWidth - 2 * REVEAL_INSET)
    );
  }
  return clampRevealWidth(remembered ?? range.defaultWidth, range);
}

/**
 * The width Canvas Reveal takes from the right of the canvas box at one level:
 * its own width and the inset beside it, or 0 while closed.
 */
export function revealOccupiedWidth(
  level: RevealLevel,
  canvasWidth: number,
  remembered: number | undefined
): number {
  const width = revealWidth(level, canvasWidth, remembered);
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

/** Elements floating over the canvas that a placed step must not sit under. */
const OBSTACLE_SELECTORS = [
  `[data-slot="${CANVAS_OBSTACLE_SLOTS.controls}"]`,
  `[data-slot="${CANVAS_OBSTACLE_SLOTS.agentPanel}"]`,
  `[data-slot="${CANVAS_OBSTACLE_SLOTS.groupScopeBar}"]`,
  ".react-flow__minimap",
];

/** Where each obstacle sits, relative to the canvas element's top left. */
export function measureObstacles(canvas: HTMLElement): Rect[] {
  const origin = canvas.getBoundingClientRect();
  const canvasArea = canvas.parentElement ?? canvas;
  return OBSTACLE_SELECTORS.flatMap((selector) =>
    [...canvasArea.querySelectorAll(selector)].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left - origin.left,
        y: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
      };
    })
  );
}

/** The box a placement must show, and the boxes it shows when they also fit. */
export type SubjectBounds = { bounds: Rect; optionalBounds: readonly Rect[] };

/**
 * The node ids a Reveal subject's placement is measured from. A placement of the
 * whole graph, or no placement, names none.
 */
export function placementNodeIds(
  placement: RevealPlacement | undefined
): readonly string[] {
  if (placement?.kind === "nodes") {
    return placement.nodeIds;
  }
  return placement?.kind === "node-outlets" ? [placement.nodeId] : [];
}

/**
 * The flow-space boxes a Reveal subject's placement names: its nodes, a node
 * with its outlet labels as optional boxes, or the whole graph.
 */
export function subjectBounds(
  placement: RevealPlacement,
  flow: Pick<
    ReactFlowInstance<WorkflowNode, WorkflowEdge>,
    "getEdges" | "getInternalNode" | "getNodes" | "getNodesBounds"
  >
): SubjectBounds {
  if (placement.kind === "nodes") {
    return {
      bounds: flow.getNodesBounds([...placement.nodeIds]),
      optionalBounds: [],
    };
  }
  if (placement.kind === "node-outlets") {
    const { bounds, labels } = outletPlacement({
      nodeId: placement.nodeId,
      nodeBounds: flow.getNodesBounds([placement.nodeId]),
      edges: flow.getEdges(),
      getInternalNode: flow.getInternalNode,
    });
    return { bounds, optionalBounds: labels };
  }
  return { bounds: flow.getNodesBounds(flow.getNodes()), optionalBounds: [] };
}
