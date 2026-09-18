/**
 * Records the camera moves a canvas asks React Flow for during one interaction,
 * and checks that the interaction moved the camera steadily. `setViewport`,
 * `fitView` and `setCenter` all reach `panZoom.setViewport`, so wrapping that
 * one method sees every placement, whether `panZoom` is React Flow's own or a
 * test stub installed before recording starts.
 */

import type { ReactFlowState } from "@xyflow/react";
import { expect } from "vitest";

type Viewport = { x: number; y: number; zoom: number };

/** One `panZoom.setViewport` call: its target and how it animates there. */
export type CameraMove = {
  viewport: Viewport;
  duration: number;
  interpolate: "smooth" | "linear";
};

/** React Flow's store, as `useStoreApi` answers it. */
type FlowStore = { getState: () => ReactFlowState };

/**
 * Start recording the camera moves of `flow`. Clear `moves` (set its length to
 * 0) to start a new interaction. React Flow's default interpolation, when a
 * call names none, is `smooth`.
 */
export function recordCameraMotion(flow: FlowStore): { moves: CameraMove[] } {
  const panZoom = flow.getState().panZoom;
  if (!panZoom) {
    throw new Error("React Flow has not created its pan and zoom handler");
  }
  const moves: CameraMove[] = [];
  const setViewport = panZoom.setViewport.bind(panZoom);
  panZoom.setViewport = (viewport, options) => {
    moves.push({
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
      duration: options?.duration ?? 0,
      interpolate: options?.interpolate ?? "smooth",
    });
    return setViewport(viewport, options);
  };
  return { moves };
}

function sameViewport(left: Viewport, right: Viewport): boolean {
  return (
    Math.abs(left.x - right.x) < 0.5 &&
    Math.abs(left.y - right.y) < 0.5 &&
    Math.abs(left.zoom - right.zoom) < 0.0001
  );
}

/**
 * Assert that `moves`, starting from the camera `start`, place the camera at
 * most once and animate only in a straight line. With one placement the
 * camera can reverse direction only inside its animation, and a `smooth`
 * animation does: it zooms out and back in on the way, which a person sees as
 * the canvas bouncing.
 */
export function expectSteadyCamera(
  moves: readonly CameraMove[],
  start: Viewport
): void {
  const targets = moves.reduce<Viewport[]>((shown, move) => {
    const previous = shown.at(-1) ?? start;
    return sameViewport(previous, move.viewport)
      ? shown
      : [...shown, move.viewport];
  }, []);
  expect(targets.length, "camera placements").toBeLessThanOrEqual(1);

  for (const move of moves) {
    if (move.duration > 0) {
      expect(move.interpolate, "animated camera interpolation").toBe("linear");
    }
  }
}
