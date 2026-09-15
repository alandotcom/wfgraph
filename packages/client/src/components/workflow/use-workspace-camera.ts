import {
  useReactFlow,
  useStore as useFlowStore,
  useStoreApi,
} from "@xyflow/react";
import { useAtomValue, useStore } from "jotai";
import { useRef } from "react";
import {
  useAfterCommit,
  useBeforePaint,
  useUnmountCleanup,
} from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  cameraStep,
  workspaceAddressId,
  type FormFactor,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import {
  activeWorkspaceAddressAtom,
  activeWorkspaceCamerasAtom,
  recordWorkspaceCameraAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  viewportFromWorldCamera,
  worldCameraFromViewport,
} from "./workflow-viewport";

type Viewport = { x: number; y: number; zoom: number };

type ShownCamera = { address: WorkspaceAddress; formFactor: FormFactor };

/**
 * Remembers the camera of each workspace scope, separately for desktop and
 * mobile. React Flow's viewport stays the live camera; a world-space snapshot
 * is stored when a movement ends, when the canvas changes size, and when the
 * scope is left, and never while a movement or animation is in progress.
 *
 * `isCanvasPlaced` answers whether the canvas has made its first placement for
 * a workflow. Before that, the viewport is not a camera anyone chose.
 */
export function useWorkspaceCamera(input: {
  isCanvasPlaced: (workflowId: string) => boolean;
}): {
  /** The viewport saved for the presented scope, when one exists. */
  savedViewport: () => Viewport | null;
  /**
   * Place the camera after the presented graph was replaced. Answers false when
   * the scope has no saved camera on its first placement, which leaves the
   * canvas's own placement rule to run.
   */
  placeReplacedGraph: () => boolean;
  /** React Flow `onMoveStart`. */
  onMoveStart: () => void;
  /** React Flow `onMoveEnd`. */
  onMoveEnd: () => void;
} {
  const store = useStore();
  const flowStore = useStoreApi();
  const { getViewport, setViewport } = useReactFlow();
  const address = useAtomValue(activeWorkspaceAddressAtom);
  const formFactor: FormFactor = useIsMobile() ? "mobile" : "desktop";
  const slotKey = `${workspaceAddressId(address)}|${formFactor}`;
  const canvasSizeKey = useFlowStore(
    (state) => `${state.width}x${state.height}`
  );
  const shownRef = useRef<ShownCamera | null>(null);
  const movingRef = useRef(false);
  const placedSlotRef = useRef<string | null>(null);

  const canvasSize = () => {
    const { width, height } = flowStore.getState();
    return width > 0 && height > 0 ? { width, height } : null;
  };

  const savedViewport = () => {
    const camera = store.get(activeWorkspaceCamerasAtom)[formFactor];
    const size = canvasSize();
    return camera && size ? viewportFromWorldCamera(camera, size) : null;
  };

  const recordShown = () => {
    const shown = shownRef.current;
    const size = canvasSize();
    if (
      shown &&
      size &&
      !movingRef.current &&
      input.isCanvasPlaced(shown.address.workflowId)
    ) {
      store.set(recordWorkspaceCameraAtom, {
        ...shown,
        camera: worldCameraFromViewport(getViewport(), size),
      });
    }
  };

  useBeforePaint(slotKey, () => {
    const shown = shownRef.current;
    const step = cameraStep({
      shown: shown && {
        addressId: workspaceAddressId(shown.address),
        formFactor: shown.formFactor,
      },
      next: { addressId: workspaceAddressId(address), formFactor },
      moving: movingRef.current,
      shownPlaced:
        shown !== null && input.isCanvasPlaced(shown.address.workflowId),
      nextPlaced: input.isCanvasPlaced(address.workflowId),
      savedForNext: store.get(activeWorkspaceCamerasAtom)[formFactor],
    });
    if (step.recordShown) {
      recordShown();
    }
    shownRef.current = { address, formFactor };
    placedSlotRef.current = null;
    const size = canvasSize();
    if (step.restore && size) {
      void setViewport(viewportFromWorldCamera(step.restore, size), {
        duration: 0,
      });
    }
  });
  useAfterCommit(canvasSizeKey, recordShown);
  useUnmountCleanup(recordShown);

  const placeReplacedGraph = () => {
    if (placedSlotRef.current === slotKey) {
      return true;
    }
    placedSlotRef.current = slotKey;
    const saved = savedViewport();
    if (!saved) {
      return false;
    }
    void setViewport(saved, { duration: 0 });
    return true;
  };

  return {
    savedViewport,
    placeReplacedGraph,
    onMoveStart: () => {
      movingRef.current = true;
    },
    onMoveEnd: () => {
      movingRef.current = false;
      recordShown();
    },
  };
}
