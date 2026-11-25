import {
  useReactFlow,
  useStore as useFlowStore,
  useStoreApi,
} from "@xyflow/react";
import { useAtomValue, useStore } from "jotai";
import { type RefObject, useRef } from "react";
import { useAfterPaint } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import { viewportAnimationDuration } from "#src/lib/motion";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  type WorldCamera,
  workspaceAddressId,
} from "#src/lib/workflow-navigation-state";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import {
  revealViewport,
  sameWorldCamera,
  viewportFromWorldCamera,
  worldCameraFromViewport,
} from "#src/components/workflow/workflow-viewport";
import { measureObstacles, usableCanvasRect } from "./reveal-geometry";
import { revealPlacementRequestAtom } from "./reveal-requests";

/**
 * The pixels the review sheet covers at the right of the canvas element, or 0
 * while it does not show. The sheet overlays the canvas from the editor's right
 * edge, so a step a review edit points at is placed beside it.
 */
function reviewSheetOverlap(canvas: HTMLElement): number {
  const sheet = document.querySelector('[data-slot="review-sheet"]');
  if (sheet === null) {
    return 0;
  }
  const canvasRect = canvas.getBoundingClientRect();
  return Math.max(0, canvasRect.right - sheet.getBoundingClientRect().left);
}

/**
 * Answers each placement request once: the command palette, an issue, an
 * outline row, a jump between scopes, and the review sheet ask for nodes to be
 * shown. The camera moves the least it must to bring those nodes fully into the
 * canvas, clear of the controls floating over it and of the review sheet, so a
 * node already in view moves nothing. A selection on its own asks for nothing,
 * and the columns beside the canvas never move it. It only calls
 * `setViewport`: no layout runs and no node moves. A request waits until its
 * address shows, the canvas can be placed, and React Flow holds every node it
 * names. `canvas` is the element React Flow fills.
 */
export function useRevealCamera(input: {
  isCanvasPlaced: (workflowId: string) => boolean;
  /** Changes when the canvas shows its first placement, so the hook looks again. */
  isCanvasReady: boolean;
  canvas: RefObject<HTMLElement | null>;
}): {
  /** React Flow `onMoveEnd`: the camera has settled on its latest target. */
  onMoveEnd: () => void;
} {
  const store = useStore();
  const flowStore = useStoreApi();
  const { getNodesBounds, getViewport, setViewport } = useReactFlow<
    WorkflowNode,
    WorkflowEdge
  >();
  const isMobile = useIsMobile();
  const isSized = useFlowStore((state) => state.width > 0 && state.height > 0);
  const request = useAtomValue(revealPlacementRequestAtom);
  const address = useAtomValue(activeWorkspaceAddressAtom);
  const isRequestHeld = useFlowStore((state) =>
    (request?.nodeIds ?? []).every((id) => state.nodeLookup.has(id))
  );
  const answeredSequenceRef = useRef(0);
  /** Where an animation this hook started is heading, until the move ends. */
  const inFlightRef = useRef<WorldCamera | null>(null);

  useAfterPaint(
    [
      request?.sequence ?? 0,
      workspaceAddressId(address),
      isMobile,
      isSized,
      input.isCanvasReady,
      isRequestHeld,
    ].join("|"),
    () => {
      const placement = store.get(revealPlacementRequestAtom);
      const { width, height } = flowStore.getState();
      const element = input.canvas.current;
      const active = store.get(activeWorkspaceAddressAtom);
      if (
        placement === null ||
        placement.sequence === answeredSequenceRef.current ||
        placement.addressId !== workspaceAddressId(active) ||
        !isRequestHeld ||
        isMobile ||
        !element ||
        width <= 0 ||
        height <= 0 ||
        !input.isCanvasPlaced(active.workflowId)
      ) {
        return;
      }
      answeredSequenceRef.current = placement.sequence;
      const bounds = getNodesBounds([...placement.nodeIds]);
      if (bounds.width <= 0 || bounds.height <= 0) {
        return;
      }
      const size = { width, height };
      const current =
        inFlightRef.current ?? worldCameraFromViewport(getViewport(), size);
      const usable = usableCanvasRect({
        canvas: size,
        rightOccupiedWidth: reviewSheetOverlap(element),
        obstacles: measureObstacles(element),
      });
      if (usable === null) {
        return;
      }
      const target = worldCameraFromViewport(
        revealViewport({
          viewport: viewportFromWorldCamera(current, size),
          usable,
          bounds,
        }),
        size
      );
      if (!sameWorldCamera(target, current)) {
        inFlightRef.current = target;
        // React Flow's default `smooth` interpolation zooms out and back in on
        // the way, so the canvas would bounce while keeping its zoom.
        void setViewport(viewportFromWorldCamera(target, size), {
          duration: viewportAnimationDuration(),
          interpolate: "linear",
        });
      }
    }
  );

  return {
    onMoveEnd: () => {
      inFlightRef.current = null;
    },
  };
}
