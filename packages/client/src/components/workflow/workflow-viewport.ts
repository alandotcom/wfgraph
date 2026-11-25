/** Shared viewport limits and fitting rules for the workflow canvas. */

import { getViewportForBounds } from "@xyflow/react";
import {
  REVEAL_CONTEXT_PX,
  REVEAL_PADDING_PX,
} from "./canvas-reveal/reveal-geometry";

export const WORKFLOW_CANVAS_MIN_ZOOM = 0.025;
export const WORKFLOW_FIT_VIEW_PADDING = 0.2;
export const WORKFLOW_FIT_VIEW_MAX_ZOOM = 1;
export const WORKFLOW_OVERVIEW_ZOOM = 0.5;

type Viewport = { x: number; y: number; zoom: number };
type Bounds = { x: number; y: number; width: number; height: number };
type CanvasSize = { width: number; height: number };

/** Every fit uses the same limits so a control cannot strand a large workflow. */
export function workflowFitViewOptions(duration: number): {
  padding: number;
  minZoom: number;
  maxZoom: number;
  duration: number;
} {
  return {
    padding: WORKFLOW_FIT_VIEW_PADDING,
    minZoom: WORKFLOW_CANVAS_MIN_ZOOM,
    maxZoom: WORKFLOW_FIT_VIEW_MAX_ZOOM,
    duration,
  };
}

export function lifecycleAnchorViewport(input: {
  canvasWidth: number;
  nodePosition: { x: number; y: number };
  nodeWidth: number;
  top: number;
  zoom: number;
}): Viewport {
  return {
    x:
      input.canvasWidth / 2 -
      (input.nodePosition.x + input.nodeWidth / 2) * input.zoom,
    y: input.top - input.nodePosition.y * input.zoom,
    zoom: input.zoom,
  };
}

/**
 * The lowest zoom a workflow opens at. A step's 12px captions (its
 * description, outlet labels, edge labels and run status chip) render at
 * 12px there, the floor of the type scale, so every line on screen can be
 * read without zooming in.
 */
export const WORKFLOW_READABLE_ZOOM = 1;

/** Screen pixels between the top of the usable canvas and an anchored Lifecycle card. */
const LIFECYCLE_TOP_PX = 48;

/** Whether `viewport` shows all of `graphBounds` inside `area`, in canvas pixels. */
function viewportShowsGraph(input: {
  area: Bounds;
  graphBounds: Bounds;
  viewport: Viewport;
}): boolean {
  const { area, graphBounds, viewport } = input;
  const left = viewport.x + graphBounds.x * viewport.zoom;
  const top = viewport.y + graphBounds.y * viewport.zoom;
  const right = left + graphBounds.width * viewport.zoom;
  const bottom = top + graphBounds.height * viewport.zoom;
  return (
    left >= area.x &&
    top >= area.y &&
    right <= area.x + area.width &&
    bottom <= area.y + area.height
  );
}

/**
 * Where the camera opens a workflow, or a workspace view that has no
 * remembered camera, inside `usable`: the canvas pixels Canvas Reveal and the
 * floating controls leave.
 *
 * The zoom fits the whole graph, never above `zoomLimit` and never below
 * `WORKFLOW_READABLE_ZOOM` unless `zoomLimit` is lower. `zoomLimit` is the
 * fit's own maximum when a workflow opens, and the current zoom when a view
 * changes, so a view change never zooms in. The Lifecycle card sits at the top
 * center of `usable` when the graph shows whole there. A graph that fits but
 * would clip at that anchor is centered. A graph too large to fit keeps the
 * anchor and runs off the bottom edge.
 */
export function openingViewport(input: {
  usable: Bounds;
  graphBounds: Bounds;
  lifecycle: { nodePosition: { x: number; y: number }; nodeWidth: number };
  zoomLimit: number;
}): Viewport {
  const { usable, graphBounds } = input;
  const fitted = getViewportForBounds(
    graphBounds,
    usable.width,
    usable.height,
    WORKFLOW_CANVAS_MIN_ZOOM,
    WORKFLOW_FIT_VIEW_MAX_ZOOM,
    WORKFLOW_FIT_VIEW_PADDING
  );
  const zoom = Math.min(
    input.zoomLimit,
    Math.max(fitted.zoom, WORKFLOW_READABLE_ZOOM)
  );
  const anchored = lifecycleAnchorViewport({
    canvasWidth: usable.width,
    nodePosition: input.lifecycle.nodePosition,
    nodeWidth: input.lifecycle.nodeWidth,
    top: usable.y + LIFECYCLE_TOP_PX,
    zoom,
  });
  const anchoredInUsable = { ...anchored, x: anchored.x + usable.x };
  if (
    viewportShowsGraph({
      area: usable,
      graphBounds,
      viewport: anchoredInUsable,
    })
  ) {
    return anchoredInUsable;
  }
  const fits =
    graphBounds.width * zoom <= usable.width &&
    graphBounds.height * zoom <= usable.height;
  if (!fits) {
    return anchoredInUsable;
  }
  return {
    x:
      usable.x +
      usable.width / 2 -
      (graphBounds.x + graphBounds.width / 2) * zoom,
    y:
      usable.y +
      usable.height / 2 -
      (graphBounds.y + graphBounds.height / 2) * zoom,
    zoom,
  };
}

/**
 * The flow-coordinate point at the middle of the canvas, with the zoom. Stored
 * in flow coordinates so a camera restored onto a canvas of another size keeps
 * the same point in the middle.
 */
export function worldCameraFromViewport(
  viewport: Viewport,
  canvas: CanvasSize
): { centerX: number; centerY: number; zoom: number } {
  return {
    centerX: (canvas.width / 2 - viewport.x) / viewport.zoom,
    centerY: (canvas.height / 2 - viewport.y) / viewport.zoom,
    zoom: viewport.zoom,
  };
}

/** The viewport that puts a stored camera's center in the middle of the canvas. */
export function viewportFromWorldCamera(
  camera: { centerX: number; centerY: number; zoom: number },
  canvas: CanvasSize
): Viewport {
  return {
    x: canvas.width / 2 - camera.centerX * camera.zoom,
    y: canvas.height / 2 - camera.centerY * camera.zoom,
    zoom: camera.zoom,
  };
}

/** Maps a continuous zoom value to the canvas's two presentation densities. */
export function workflowZoomPresentation(zoom: number): "detail" | "overview" {
  return zoom <= WORKFLOW_OVERVIEW_ZOOM ? "overview" : "detail";
}

/**
 * The minimum axis translation that moves the span `[start, end]` inside
 * `[min, max]`. A span wider than the range is centered in it.
 */
function axisShift(input: {
  start: number;
  end: number;
  min: number;
  max: number;
}): number {
  const { start, end, min, max } = input;
  if (end - start > max - min) {
    return (min + max) / 2 - (start + end) / 2;
  }
  if (start < min) {
    return min - start;
  }
  if (end > max) {
    return max - end;
  }
  return 0;
}

/**
 * The viewport that places `bounds` (flow coordinates) inside `usable` (canvas
 * pixels) for Canvas Reveal. The zoom is kept when the bounds fit and otherwise
 * decreases just enough to fit them, scaled around their center. Each box in
 * `optionalBounds` then grows the placed box, in order, while the grown box
 * still fits at that zoom; one that does not fit is left out. Each axis moves
 * the least distance that brings the placed box, with `context` screen pixels
 * of neighboring canvas on every side when that still fits, inside `usable`
 * less `padding`. The answer is `viewport` itself when nothing needs to move.
 */
export function revealViewport(input: {
  viewport: Viewport;
  usable: Bounds;
  bounds: Bounds;
  optionalBounds?: readonly Bounds[] | undefined;
  padding?: number | undefined;
  context?: number | undefined;
}): Viewport {
  const { viewport, usable, bounds } = input;
  const padding = input.padding ?? REVEAL_PADDING_PX;
  const context = input.context ?? REVEAL_CONTEXT_PX;
  const room = {
    width: usable.width - 2 * padding,
    height: usable.height - 2 * padding,
  };
  const fitZoom = Math.min(
    room.width / Math.max(bounds.width, 1),
    room.height / Math.max(bounds.height, 1)
  );
  const zoom = Math.min(
    viewport.zoom,
    Math.max(fitZoom, WORKFLOW_CANVAS_MIN_ZOOM)
  );
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const scaled = {
    x: viewport.x + centerX * (viewport.zoom - zoom),
    y: viewport.y + centerY * (viewport.zoom - zoom),
  };
  const placed = (input.optionalBounds ?? []).reduce((box, optional) => {
    const grown = unionBounds(box, optional);
    return grown.width * zoom <= room.width &&
      grown.height * zoom <= room.height
      ? grown
      : box;
  }, bounds);
  const withContext =
    zoom === viewport.zoom &&
    placed.width * zoom + 2 * context <= room.width &&
    placed.height * zoom + 2 * context <= room.height
      ? context
      : 0;
  const min = { x: usable.x + padding, y: usable.y + padding };
  const shiftX = axisShift({
    start: scaled.x + placed.x * zoom - withContext,
    end: scaled.x + (placed.x + placed.width) * zoom + withContext,
    min: min.x,
    max: min.x + room.width,
  });
  const shiftY = axisShift({
    start: scaled.y + placed.y * zoom - withContext,
    end: scaled.y + (placed.y + placed.height) * zoom + withContext,
    min: min.y,
    max: min.y + room.height,
  });
  if (zoom === viewport.zoom && shiftX === 0 && shiftY === 0) {
    return viewport;
  }
  return { x: scaled.x + shiftX, y: scaled.y + shiftY, zoom };
}

function unionBounds(left: Bounds, right: Bounds): Bounds {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y,
  };
}

/**
 * Whether two cameras show the same view: centers within half a screen pixel
 * and zooms within a thousandth.
 */
export function sameWorldCamera(
  left: { centerX: number; centerY: number; zoom: number },
  right: { centerX: number; centerY: number; zoom: number }
): boolean {
  return (
    Math.abs(left.zoom - right.zoom) < 1e-3 &&
    Math.abs(left.centerX - right.centerX) * left.zoom < 0.5 &&
    Math.abs(left.centerY - right.centerY) * left.zoom < 0.5
  );
}
