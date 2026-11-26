import { useReactFlow, useStoreApi } from "@xyflow/react";
import { useStore } from "jotai";
import type { RefObject } from "react";
import { compact } from "es-toolkit/array";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { canvasRevealAtom } from "./canvas-reveal/canvas-reveal-state";
import {
  measureCoveredRightWidth,
  measureObstacles,
  placementNodeIds,
  usableCanvasRect,
} from "./canvas-reveal/reveal-geometry";
import { openingViewport, revealViewport } from "./workflow-viewport";

/**
 * Places the camera where a workflow opens, or where a workspace view with no
 * remembered camera starts, in one `setViewport` with no animation. The graph
 * is placed by `openingViewport` inside the usable canvas: the canvas less the
 * controls and the outline floating over it, and less the Inspector card or
 * the review sheet where either covers its right edge. Then the nodes the Inspector's subject
 * names, or on a run that stopped the step where it stopped, move the least
 * distance that keeps them inside that usable canvas. A step inside a collapsed Group is placed by its Group card.
 *
 * `paintedNodes` are the nodes the active scope paints, and `graphNodes` every
 * node of the presented graph. The returned function answers false, and moves
 * nothing, while the canvas has no size or paints no node.
 */
export function useOpeningCamera(input: {
  canvas: RefObject<HTMLElement | null>;
  paintedNodes: readonly WorkflowNode[];
  graphNodes: readonly WorkflowNode[];
}): (placement: {
  lifecycle: { nodePosition: { x: number; y: number }; nodeWidth: number };
  /** The highest zoom the placement may choose. */
  zoomLimit: number;
}) => boolean {
  const store = useStore();
  const flowStore = useStoreApi();
  const { getNodesBounds, setViewport } = useReactFlow();

  /** The painted nodes the placement keeps in view after placing the graph. */
  const nodesToPlace = (): WorkflowNode[] => {
    const reveal = store.get(canvasRevealAtom);
    const subjectIds = placementNodeIds(reveal.subject?.placement);
    const stoppedNodeId = store.get(executionOverlayGraphAtom)?.stoppedNodeId;
    const ids =
      subjectIds.length > 0 ? subjectIds : compact([stoppedNodeId ?? null]);
    const painted = new Map(input.paintedNodes.map((node) => [node.id, node]));
    return compact(
      ids.map((id) => {
        const parentId = input.graphNodes.find(
          (node) => node.id === id
        )?.parentId;
        return painted.get(id) ?? (parentId ? painted.get(parentId) : null);
      })
    );
  };

  return (placement) => {
    const { width, height } = flowStore.getState();
    if (width <= 0 || height <= 0 || input.paintedNodes.length === 0) {
      return false;
    }
    const canvas = { width, height };
    const element = input.canvas.current;
    const usable = usableCanvasRect({
      canvas,
      rightOccupiedWidth: element ? measureCoveredRightWidth(element) : 0,
      obstacles: element ? measureObstacles(element) : [],
    }) ?? { x: 0, y: 0, ...canvas };
    const opening = openingViewport({
      usable,
      graphBounds: getNodesBounds([...input.paintedNodes]),
      lifecycle: placement.lifecycle,
      zoomLimit: placement.zoomLimit,
    });
    const placed = nodesToPlace();
    const viewport =
      placed.length > 0
        ? revealViewport({
            viewport: opening,
            usable,
            bounds: getNodesBounds(placed),
          })
        : opening;
    void setViewport(viewport, { duration: 0 });
    return true;
  };
}
