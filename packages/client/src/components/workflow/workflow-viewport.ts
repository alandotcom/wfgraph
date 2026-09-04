/** Shared viewport limits and fitting rules for the workflow canvas. */

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

/** Maps a continuous zoom value to the canvas's two presentation densities. */
export function workflowZoomPresentation(zoom: number): "detail" | "overview" {
  return zoom <= WORKFLOW_OVERVIEW_ZOOM ? "overview" : "detail";
}
