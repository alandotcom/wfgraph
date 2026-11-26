import { useReactFlow, useStoreApi } from "@xyflow/react";
import { useAtomValue, useStore } from "jotai";
import { useRef, type RefObject } from "react";
import { compact } from "es-toolkit/array";
import { useAfterPaint } from "#src/hooks/effects";
import { viewportAnimationDuration } from "#src/lib/motion";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { workflowGraphUpdateAtom } from "#src/lib/workflow-ui-store";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  canvasRevealAtom,
  inspectorCoveredWidthAtom,
} from "./canvas-reveal/canvas-reveal-state";
import {
  measureCoveredRightWidth,
  measureObstacles,
  placementNodeIds,
  usableCanvasRect,
} from "./canvas-reveal/reveal-geometry";
import {
  openingViewport,
  revealViewport,
  WORKFLOW_FIT_VIEW_MAX_ZOOM,
} from "./workflow-viewport";

/** The Lifecycle card's flow position and width, which an opening anchors on. */
type LifecyclePlacement = {
  nodePosition: { x: number; y: number };
  nodeWidth: number;
};

type OpeningPlacement = {
  /** The Lifecycle card, or null to anchor on the top of the graph. */
  lifecycle: LifecyclePlacement | null;
  /** The highest zoom the placement may choose. */
  zoomLimit: number;
  /** Milliseconds the camera takes to get there, 0 by default. */
  duration?: number | undefined;
};

/**
 * Places the camera where a workflow opens, or where a workspace view with no
 * remembered camera starts, in one `setViewport`. The graph is placed by
 * `openingViewport` inside the usable canvas: the canvas less the
 * controls and the outline floating over it, and less the Inspector card or
 * the review sheet where either covers its right edge. Then the nodes the Inspector's subject
 * names, or on a run that stopped the step where it stopped, move the least
 * distance that keeps them inside that usable canvas, at the zoom the graph
 * was placed at. A step inside a collapsed Group is placed by its Group card.
 *
 * The hook also places the graph this way, animated and anchored on the
 * painted Lifecycle card, after each `workflowGraphUpdateAtom` revision for the
 * open workflow: an agent's edit, a draft saved elsewhere, and Tidy layout.
 *
 * `paintedNodes` are the nodes the active scope paints, and `graphNodes` every
 * node of the presented graph. The returned function answers false, and moves
 * nothing, while the canvas has no size or paints no node.
 */
export function useOpeningCamera(input: {
  canvas: RefObject<HTMLElement | null>;
  paintedNodes: readonly WorkflowNode[];
  graphNodes: readonly WorkflowNode[];
}): (placement: OpeningPlacement) => boolean {
  const store = useStore();
  const flowStore = useStoreApi();
  const { getNodesBounds, setViewport } = useReactFlow();
  const graphUpdate = useAtomValue(workflowGraphUpdateAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  // The revision the hook mounted at is a graph the opening already placed.
  const handledRevisionRef = useRef(graphUpdate?.revision ?? 0);
  // A phone has no Inspector card.
  const isMobile = useIsMobile();

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

  const place = (placement: OpeningPlacement): boolean => {
    const { width, height } = flowStore.getState();
    if (width <= 0 || height <= 0 || input.paintedNodes.length === 0) {
      return false;
    }
    const canvas = { width, height };
    const element = input.canvas.current;
    const usable = usableCanvasRect({
      canvas,
      rightOccupiedWidth: element
        ? measureCoveredRightWidth(
            element,
            isMobile ? 0 : store.get(inspectorCoveredWidthAtom)
          )
        : 0,
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
            minZoom: opening.zoom,
          })
        : opening;
    // React Flow's default `smooth` interpolation zooms out and back in on the
    // way, so an animated placement would bounce.
    void setViewport(viewport, {
      duration: placement.duration ?? 0,
      interpolate: "linear",
    });
    return true;
  };

  /** The painted Lifecycle card where React Flow holds it, or null. */
  const paintedLifecycle = (): LifecyclePlacement | null => {
    const lifecycle = input.paintedNodes.find(
      (node) => node.data.type === "lifecycle"
    );
    if (!lifecycle) {
      return null;
    }
    const box = getNodesBounds([lifecycle]);
    return { nodePosition: { x: box.x, y: box.y }, nodeWidth: box.width };
  };

  // After paint, so React Flow holds the replaced graph the placement measures.
  useAfterPaint(graphUpdate?.revision ?? 0, () => {
    if (!graphUpdate || graphUpdate.revision <= handledRevisionRef.current) {
      return;
    }
    handledRevisionRef.current = graphUpdate.revision;
    if (graphUpdate.workflowId !== workflowId) {
      return;
    }
    place({
      lifecycle: paintedLifecycle(),
      zoomLimit: WORKFLOW_FIT_VIEW_MAX_ZOOM,
      duration: viewportAnimationDuration(),
    });
  });

  return place;
}
