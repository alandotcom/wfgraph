import {
  getViewportForBounds,
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
  type WorldCamera,
} from "#src/lib/workflow-navigation-state";
import {
  activeWorkspaceAddressAtom,
  activeWorkspaceCamerasAtom,
  recordWorkspaceCameraAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  viewportFromWorldCamera,
  workflowFitViewOptions,
  worldCameraFromViewport,
} from "./workflow-viewport";

type Viewport = { x: number; y: number; zoom: number };

type ShownCamera = { address: WorkspaceAddress; formFactor: FormFactor };

type CanvasSize = { width: number; height: number };

/**
 * The camera a form factor change asked for: the saved camera of the slot
 * reached, or a fit of the graph when that slot has none. `sizeKey` is the
 * canvas size the change saw, which is still the size of the layout being left.
 */
type PendingPlacement = {
  placement: { kind: "restore"; camera: WorldCamera } | { kind: "fit" };
  sizeKey: string;
};

/**
 * Remembers the camera of each workspace scope, separately for desktop and
 * mobile. React Flow's viewport stays the live camera; a world-space snapshot
 * is stored when a movement ends, when the canvas changes size, and when the
 * scope is left, and never while a movement or animation is in progress.
 *
 * `isCanvasPlaced` answers whether the canvas has made its first placement for
 * a workflow. Before that, the viewport is not a camera anyone chose.
 *
 * The media query can report a form factor change before React Flow measures
 * the resized canvas. The camera the change asks for is placed at once and held
 * until the canvas reports a new size, then placed again against that size in
 * place of recording the viewport. The canvas size can also arrive in the same
 * commit as the form factor change, so the camera being left is recorded
 * against the size it was shown at. A form factor visited for the first time
 * with no saved camera fits the graph.
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
  const { getNodes, getNodesBounds, getViewport, setViewport } = useReactFlow();
  const address = useAtomValue(activeWorkspaceAddressAtom);
  const formFactor: FormFactor = useIsMobile() ? "mobile" : "desktop";
  const slotKey = `${workspaceAddressId(address)}|${formFactor}`;
  const canvasSizeKey = useFlowStore(
    (state) => `${state.width}x${state.height}`
  );
  const shownRef = useRef<ShownCamera | null>(null);
  const movingRef = useRef(false);
  const placedSlotRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingPlacement | null>(null);
  // The canvas size the last size change was handled at. A browser can deliver
  // a new canvas size in the same commit as a form factor change, and the
  // camera being left belongs to the size before that commit.
  const handledSizeRef = useRef<CanvasSize | null>(null);

  const canvasSize = () => {
    const { width, height } = flowStore.getState();
    return width > 0 && height > 0 ? { width, height } : null;
  };

  const place = (
    placement: PendingPlacement["placement"],
    size: CanvasSize
  ) => {
    if (placement.kind === "restore") {
      void setViewport(viewportFromWorldCamera(placement.camera, size), {
        duration: 0,
      });
      return;
    }
    const nodes = getNodes();
    if (nodes.length === 0) {
      return;
    }
    const options = workflowFitViewOptions(0);
    void setViewport(
      getViewportForBounds(
        getNodesBounds(nodes),
        size.width,
        size.height,
        options.minZoom,
        options.maxZoom,
        options.padding
      ),
      { duration: 0 }
    );
  };

  const savedViewport = () => {
    const camera = store.get(activeWorkspaceCamerasAtom)[formFactor];
    const size = canvasSize();
    return camera && size ? viewportFromWorldCamera(camera, size) : null;
  };

  const recordShown = (size: CanvasSize | null = canvasSize()) => {
    const shown = shownRef.current;
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
      recordShown(handledSizeRef.current ?? canvasSize());
    }
    shownRef.current = { address, formFactor };
    placedSlotRef.current = null;
    pendingRef.current = null;
    const size = canvasSize();
    const formFactorChanged =
      shown !== null &&
      shown.formFactor !== formFactor &&
      workspaceAddressId(shown.address) === workspaceAddressId(address) &&
      input.isCanvasPlaced(address.workflowId);
    const placement: PendingPlacement["placement"] | null = step.restore
      ? { kind: "restore", camera: step.restore }
      : formFactorChanged
        ? { kind: "fit" }
        : null;
    if (placement && size) {
      place(placement, size);
    }
    // Set after placing, since React Flow reports a programmatic move through
    // `onMoveStart`, which drops a pending placement.
    if (placement && formFactorChanged) {
      pendingRef.current = { placement, sizeKey: canvasSizeKey };
    }
  });
  useAfterCommit(canvasSizeKey, () => {
    const pending = pendingRef.current;
    const size = canvasSize();
    if (pending && size && pending.sizeKey !== canvasSizeKey) {
      pendingRef.current = null;
      handledSizeRef.current = size;
      place(pending.placement, size);
      return;
    }
    handledSizeRef.current = size;
    recordShown(size);
  });
  useUnmountCleanup(() => recordShown());

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
      pendingRef.current = null;
    },
    onMoveEnd: () => {
      movingRef.current = false;
      recordShown();
    },
  };
}
