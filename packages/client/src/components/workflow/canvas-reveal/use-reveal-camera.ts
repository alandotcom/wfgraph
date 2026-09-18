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
import type { WorldCamera } from "#src/lib/workflow-navigation-state";
import { isAgentPanelExpandedAtom } from "#src/lib/workflow-ui-store";
import {
  revealViewport,
  sameWorldCamera,
  viewportFromWorldCamera,
  worldCameraFromViewport,
} from "#src/components/workflow/workflow-viewport";
import { canvasRevealAtom } from "./canvas-reveal-state";
import { revealCameraStep, type RevealCameraSlot } from "./reveal-camera";
import {
  measureObstacles,
  revealOccupiedWidth,
  subjectBounds,
  type SubjectBounds,
  usableCanvasRect,
} from "./reveal-geometry";
import {
  revealKeyResizeInProgressAtom,
  revealPlacementRequestAtom,
  revealResizeSequenceAtom,
} from "./reveal-requests";
import { rememberedRevealWidthsAtom } from "./reveal-width-preference";

/**
 * Moves the desktop camera the least it must when Canvas Reveal opens, changes
 * subject, widens to Focus, finishes a resize, or answers a placement request,
 * so the subject stays visible beside it. The camera starts from where it is,
 * so a subject Reveal does not cover moves nothing. It only calls
 * `setViewport`: no layout runs and no node moves. Closing Reveal never moves
 * the camera. A keyboard resize places from the camera recorded when it began,
 * even if an earlier placement was still animating then. Nothing is compared
 * while the canvas cannot be placed, so a change made then is acted on once it
 * can.
 * `canvas` is the element React Flow fills.
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
  const flow = useReactFlow<WorkflowNode, WorkflowEdge>();
  const { getNodesBounds, getViewport, setViewport } = flow;
  const isMobile = useIsMobile();
  const isSized = useFlowStore((state) => state.width > 0 && state.height > 0);
  const reveal = useAtomValue(canvasRevealAtom);
  const request = useAtomValue(revealPlacementRequestAtom);
  const resizeSequence = useAtomValue(revealResizeSequenceAtom);
  const isKeyResizing = useAtomValue(revealKeyResizeInProgressAtom);
  /** The slot the camera last acted on while the canvas could be placed. */
  const shownRef = useRef<RevealCameraSlot | null>(null);
  const answeredSequenceRef = useRef(0);
  /** Where an animation this hook started is heading, until the move ends. */
  const inFlightRef = useRef<WorldCamera | null>(null);
  /** The camera when the keyboard resize in progress began. */
  const keyResizeStartRef = useRef<WorldCamera | null>(null);
  const slotKey = [
    reveal.addressId,
    reveal.subject?.key ?? "",
    reveal.level,
    request?.sequence ?? 0,
    resizeSequence,
    isKeyResizing,
    isMobile,
    isSized,
    input.isCanvasReady,
  ].join("|");

  useAfterPaint(slotKey, () => {
    const state = store.get(canvasRevealAtom);
    const { width, height } = flowStore.getState();
    const element = input.canvas.current;
    if (
      isMobile ||
      !element ||
      width <= 0 ||
      height <= 0 ||
      !input.isCanvasPlaced(state.address.workflowId)
    ) {
      return;
    }
    const size = { width, height };
    const current =
      inFlightRef.current ?? worldCameraFromViewport(getViewport(), size);
    // Record the camera once when a keyboard resize begins, and hand it to the
    // placement that ends the resize.
    const keyResizeStart = keyResizeStartRef.current ?? current;
    keyResizeStartRef.current = store.get(revealKeyResizeInProgressAtom)
      ? keyResizeStart
      : null;
    const next: RevealCameraSlot = {
      addressId: state.addressId,
      subjectKey: state.subject?.key ?? null,
      level: state.level,
      resizeSequence: store.get(revealResizeSequenceAtom),
    };
    const placementRequest = store.get(revealPlacementRequestAtom);
    const finishedResize =
      shownRef.current !== null &&
      shownRef.current.resizeSequence !== next.resizeSequence;
    const step = revealCameraStep({
      shown: shownRef.current,
      next,
      request: placementRequest,
      answeredSequence: answeredSequenceRef.current,
    });
    shownRef.current = next;
    if (step === "keep") {
      return;
    }

    let placed: SubjectBounds | null = null;
    if (step === "place-request" && placementRequest) {
      answeredSequenceRef.current = placementRequest.sequence;
      placed = {
        bounds: getNodesBounds([...placementRequest.nodeIds]),
        optionalBounds: [],
      };
    } else if (state.subject) {
      placed = subjectBounds(state.subject.placement, flow);
    }
    if (!placed || placed.bounds.width <= 0 || placed.bounds.height <= 0) {
      return;
    }
    const { bounds, optionalBounds } = placed;
    const from = finishedResize ? keyResizeStart : current;
    const usable = store.get(isAgentPanelExpandedAtom)
      ? null
      : usableCanvasRect({
          canvas: size,
          revealOccupiedWidth: revealOccupiedWidth(
            state.level,
            width,
            state.focusWidth,
            store.get(rememberedRevealWidthsAtom)
          ),
          obstacles: measureObstacles(element),
        });
    const target = usable
      ? worldCameraFromViewport(
          revealViewport({
            viewport: viewportFromWorldCamera(from, size),
            usable,
            bounds,
            optionalBounds,
          }),
          size
        )
      : current;
    if (!sameWorldCamera(target, current)) {
      inFlightRef.current = target;
      // React Flow's default `smooth` interpolation zooms out and back in on
      // the way, so the canvas would bounce while keeping its zoom.
      void setViewport(viewportFromWorldCamera(target, size), {
        duration: viewportAnimationDuration(),
        interpolate: "linear",
      });
    }
  });

  return {
    onMoveEnd: () => {
      inFlightRef.current = null;
    },
  };
}
