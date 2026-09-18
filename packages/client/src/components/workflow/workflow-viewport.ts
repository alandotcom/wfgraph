/** Shared viewport limits and fitting rules for the workflow canvas. */

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

/** Whether a viewport leaves every edge of the workflow graph on the canvas. */
export function viewportContainsGraph(input: {
  canvas: CanvasSize;
  graphBounds: Bounds;
  viewport: Viewport;
}): boolean {
  const left = input.viewport.x + input.graphBounds.x * input.viewport.zoom;
  const top = input.viewport.y + input.graphBounds.y * input.viewport.zoom;
  const right =
    input.viewport.x +
    (input.graphBounds.x + input.graphBounds.width) * input.viewport.zoom;
  const bottom =
    input.viewport.y +
    (input.graphBounds.y + input.graphBounds.height) * input.viewport.zoom;

  return (
    left >= 0 &&
    top >= 0 &&
    right <= input.canvas.width &&
    bottom <= input.canvas.height
  );
}

/**
 * Keep the Lifecycle card at the initial reading position when that preserves
 * the whole graph. A larger graph keeps React Flow's centered fitted viewport.
 */
export function initialWorkflowViewport(input: {
  canvas: CanvasSize;
  graphBounds: Bounds;
  lifecycle: {
    nodePosition: { x: number; y: number };
    nodeWidth: number;
    top: number;
  };
  fittedViewport: Viewport;
}): Viewport {
  const anchored = lifecycleAnchorViewport({
    canvasWidth: input.canvas.width,
    nodePosition: input.lifecycle.nodePosition,
    nodeWidth: input.lifecycle.nodeWidth,
    top: input.lifecycle.top,
    zoom: input.fittedViewport.zoom,
  });

  return viewportContainsGraph({
    canvas: input.canvas,
    graphBounds: input.graphBounds,
    viewport: anchored,
  })
    ? anchored
    : input.fittedViewport;
}

/** Center graph bounds while retaining the user's current zoom level. */
export function centeredViewport(input: {
  canvas: CanvasSize;
  graphBounds: Bounds;
  zoom: number;
}): Viewport {
  return {
    x:
      input.canvas.width / 2 -
      (input.graphBounds.x + input.graphBounds.width / 2) * input.zoom,
    y:
      input.canvas.height / 2 -
      (input.graphBounds.y + input.graphBounds.height / 2) * input.zoom,
    zoom: input.zoom,
  };
}

/**
 * Locate an incoming presentation without changing the existing zoom.
 * The Lifecycle anchor wins when it contains the graph; otherwise graph bounds
 * are centered so a view switch cannot leave the incoming graph off canvas.
 */
export function presentationViewport(input: {
  canvas: CanvasSize;
  currentViewport: Viewport;
  graphBounds: Bounds;
  lifecycle: {
    nodePosition: { x: number; y: number };
    nodeWidth: number;
    top: number;
  };
}): Viewport {
  const anchored = lifecycleAnchorViewport({
    canvasWidth: input.canvas.width,
    nodePosition: input.lifecycle.nodePosition,
    nodeWidth: input.lifecycle.nodeWidth,
    top: input.lifecycle.top,
    zoom: input.currentViewport.zoom,
  });

  return viewportContainsGraph({
    canvas: input.canvas,
    graphBounds: input.graphBounds,
    viewport: anchored,
  })
    ? anchored
    : centeredViewport({
        canvas: input.canvas,
        graphBounds: input.graphBounds,
        zoom: input.currentViewport.zoom,
      });
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
