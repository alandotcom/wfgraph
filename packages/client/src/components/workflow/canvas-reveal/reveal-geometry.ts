/**
 * The part of the canvas a placement may use and the boxes it measures. All
 * values are CSS pixels measured inside the canvas box, except
 * `subjectBounds`, which answers in flow space.
 */

import type { ReactFlowInstance } from "@xyflow/react";
import { maxBy } from "es-toolkit/array";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { outletPlacement } from "./reveal-outlets";
import type { RevealPlacement } from "./reveal-subject";

export type Rect = { x: number; y: number; width: number; height: number };

/** Screen pixels between a placed step and the edge of the usable rectangle. */
export const REVEAL_PADDING_PX = 24;

/** Screen pixels of neighboring canvas kept around a step Reveal places. */
export const REVEAL_CONTEXT_PX = 64;

/**
 * The screen pixels the agent's prompt line grows by when a step is selected,
 * for the row naming that step above the text box. Every fit and every
 * placement reserves it, so selecting a step after a fit never covers the
 * cards the fit placed at the bottom of the canvas. While the row already
 * shows, the reserve leaves that much more room.
 */
export const AGENT_CONTEXT_ROW_PX = 24;

/**
 * The `data-slot` values of the elements floating over the canvas that a placed
 * step must stay clear of. The elements carry them and the camera measures them.
 */
export const CANVAS_OBSTACLE_SLOTS = {
  controls: "workflow-canvas-controls",
} as const;

/** The smallest rectangle worth placing a selected step in. */
export const MIN_USABLE_SIZE = { width: 240, height: 160 } as const;

/** The smallest rectangle above a mobile summary sheet worth placing a step in. */
const MOBILE_MIN_USABLE_SIZE = { width: 200, height: 120 } as const;

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
 * The part of the canvas a placed step may sit in: the canvas less
 * `rightOccupiedWidth`, which the review sheet covers at its right edge, less
 * each obstacle that overlaps it. An obstacle trims the side that keeps the
 * most area, and is ignored when every trim would leave less than `minSize`.
 * Null when the sheet leaves less than `minSize`.
 */
export function usableCanvasRect(input: {
  canvas: { width: number; height: number };
  /** The width covered at the canvas's right edge. */
  rightOccupiedWidth: number;
  obstacles: readonly Rect[];
  minSize?: { width: number; height: number } | undefined;
}): Rect | null {
  const minSize = input.minSize ?? MIN_USABLE_SIZE;
  let usable: Rect = {
    x: 0,
    y: 0,
    width: input.canvas.width - input.rightOccupiedWidth,
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
    rightOccupiedWidth: 0,
    obstacles: [sheet, ...input.obstacles],
    minSize,
  });
}

/**
 * Elements floating over the canvas that a placed step must not sit under:
 * the agent's prompt line at the bottom of the canvas, the outline floating
 * at its top left, the zoom controls and the minimap.
 */
const AGENT_COMPOSER_SELECTOR = '[data-slot="agent-composer"]';
const OBSTACLE_SELECTORS = [
  AGENT_COMPOSER_SELECTOR,
  '[data-slot="floating-outline"]',
  `[data-slot="${CANVAS_OBSTACLE_SLOTS.controls}"]`,
  ".react-flow__minimap",
];

/**
 * Where each obstacle sits, relative to the canvas element's top left. The
 * agent's prompt line also covers `AGENT_CONTEXT_ROW_PX` above itself, the row
 * a selection adds to it.
 */
export function measureObstacles(canvas: HTMLElement): Rect[] {
  const origin = canvas.getBoundingClientRect();
  const canvasArea =
    canvas.closest('[data-slot="canvas-box"]') ??
    canvas.parentElement ??
    canvas;
  return OBSTACLE_SELECTORS.flatMap((selector) =>
    [...canvasArea.querySelectorAll(selector)].map((element) => {
      const rect = element.getBoundingClientRect();
      const above =
        selector === AGENT_COMPOSER_SELECTOR ? AGENT_CONTEXT_ROW_PX : 0;
      return {
        x: rect.left - origin.left,
        y: rect.top - origin.top - above,
        width: rect.width,
        height: rect.height + above,
      };
    })
  );
}

/**
 * The pixels covered at the right of the canvas element: by the review sheet,
 * which overlays the canvas from the editor's right edge, or by the Inspector
 * card, whichever covers more. `inspectorWidth` is the card's covered width as
 * `inspectorCoveredWidthAtom` publishes it, 0 while it is closed or on a
 * phone. The card is not measured, because it may still be sliding in.
 */
export function measureCoveredRightWidth(
  canvas: HTMLElement,
  inspectorWidth: number
): number {
  const sheet = document.querySelector('[data-slot="review-sheet"]');
  const sheetOverlap =
    sheet === null
      ? 0
      : Math.max(
          0,
          canvas.getBoundingClientRect().right -
            sheet.getBoundingClientRect().left
        );
  return Math.max(sheetOverlap, inspectorWidth);
}

/** The box a placement must show, and the boxes it shows when they also fit. */
export type SubjectBounds = { bounds: Rect; optionalBounds: readonly Rect[] };

/**
 * The node ids a subject's placement is measured from. A placement of the
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
