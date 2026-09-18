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
  CANVAS_OBSTACLE_SLOTS,
  type Rect,
  revealOccupiedWidth,
  usableCanvasRect,
} from "./reveal-geometry";
import { outletPlacement } from "./reveal-outlets";
import { revealPlacementRequestAtom } from "./reveal-requests";

/** Elements floating over the canvas that a placed step must not sit under. */
const OBSTACLE_SELECTORS = [
  `[data-slot="${CANVAS_OBSTACLE_SLOTS.controls}"]`,
  `[data-slot="${CANVAS_OBSTACLE_SLOTS.agentPanel}"]`,
  `[data-slot="${CANVAS_OBSTACLE_SLOTS.groupScopeBar}"]`,
  ".react-flow__minimap",
];

/** Where each obstacle sits, relative to the canvas element's top left. */
function measureObstacles(canvas: HTMLElement): Rect[] {
  const origin = canvas.getBoundingClientRect();
  const area = canvas.parentElement ?? canvas;
  return OBSTACLE_SELECTORS.flatMap((selector) =>
    [...area.querySelectorAll(selector)].map((element) => {
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

/**
 * Moves the desktop camera the least it must when Canvas Reveal opens, changes
 * subject, widens to Focus, or answers a placement request, so the subject
 * stays visible beside it. The camera starts from where it is, so a subject
 * Reveal does not cover moves nothing. It only calls `setViewport`: no layout
 * runs and no node moves. Closing Reveal never moves the camera. Nothing is
 * compared while the canvas cannot be placed, so a change made then is acted
 * on once it can.
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
  const {
    getEdges,
    getInternalNode,
    getNodes,
    getNodesBounds,
    getViewport,
    setViewport,
  } = useReactFlow();
  const isMobile = useIsMobile();
  const isSized = useFlowStore((state) => state.width > 0 && state.height > 0);
  const reveal = useAtomValue(canvasRevealAtom);
  const request = useAtomValue(revealPlacementRequestAtom);
  /** The slot the camera last acted on while the canvas could be placed. */
  const shownRef = useRef<RevealCameraSlot | null>(null);
  const answeredSequenceRef = useRef(0);
  /** Where an animation this hook started is heading, until the move ends. */
  const inFlightRef = useRef<WorldCamera | null>(null);
  const slotKey = [
    reveal.addressId,
    reveal.subject?.key ?? "",
    reveal.level,
    request?.sequence ?? 0,
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
    const next: RevealCameraSlot = {
      addressId: state.addressId,
      subjectKey: state.subject?.key ?? null,
      level: state.level,
    };
    const placementRequest = store.get(revealPlacementRequestAtom);
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
    const size = { width, height };
    const current =
      inFlightRef.current ?? worldCameraFromViewport(getViewport(), size);

    let bounds: Rect | null = null;
    let optionalBounds: readonly Rect[] = [];
    if (step === "place-request" && placementRequest) {
      answeredSequenceRef.current = placementRequest.sequence;
      bounds = getNodesBounds([...placementRequest.nodeIds]);
    } else if (state.subject?.placement.kind === "nodes") {
      bounds = getNodesBounds([...state.subject.placement.nodeIds]);
    } else if (state.subject?.placement.kind === "node-outlets") {
      const { nodeId } = state.subject.placement;
      const placement = outletPlacement({
        nodeId,
        nodeBounds: getNodesBounds([nodeId]),
        edges: getEdges(),
        getInternalNode,
      });
      bounds = placement.bounds;
      optionalBounds = placement.labels;
    } else if (state.subject?.placement.kind === "graph") {
      bounds = getNodesBounds(getNodes());
    }
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      return;
    }
    const usable = store.get(isAgentPanelExpandedAtom)
      ? null
      : usableCanvasRect({
          canvas: size,
          revealOccupiedWidth: revealOccupiedWidth(
            state.level,
            width,
            state.focusWidth
          ),
          obstacles: measureObstacles(element),
        });
    const target = usable
      ? worldCameraFromViewport(
          revealViewport({
            viewport: viewportFromWorldCamera(current, size),
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
