import { act, render } from "@testing-library/react";
import {
  ReactFlowProvider,
  type ReactFlowState,
  useStoreApi,
} from "@xyflow/react";
import { createStore, Provider as JotaiProvider, useAtomValue } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canvasNodesAtom,
  loadWorkflowGraphAtom,
  onNodesChangeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import {
  expectSteadyCamera,
  recordCameraMotion,
} from "#src/components/workflow/camera-motion-test-support";
import { useWorkspaceCamera } from "./use-workspace-camera";

const CANVAS = { width: 1200, height: 800 };
const PHONE_CANVAS = { width: 393, height: 700 };

const NODES: WorkflowNode[] = [
  {
    id: "g",
    type: "group",
    position: { x: 0, y: 0 },
    data: { label: "Group", type: "group" },
  },
  {
    id: "a",
    type: "action",
    parentId: "g",
    position: { x: 12, y: 48 },
    data: { label: "a", type: "action" },
  },
  {
    id: "b",
    type: "action",
    parentId: "g",
    position: { x: 12, y: 144 },
    data: { label: "b", type: "action" },
  },
];

type Viewport = { x: number; y: number; zoom: number };
type CanvasSize = { width: number; height: number };

function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

/**
 * The hook inside a real React Flow store whose `panZoom` records each
 * `setViewport` and applies it at once, with every workflow already placed. The
 * painted nodes are the ones the canvas paints for the active scope.
 */
function renderCamera(options: { revealOccupiedWidth?: number } = {}) {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(loadWorkflowGraphAtom, { nodes: NODES, edges: [] });
  showWorkspaceRoute(store, {});

  const moves: Viewport[] = [];
  let flow: {
    getState: () => ReactFlowState;
    setState: (state: Partial<ReactFlowState>) => void;
  } | null = null;
  let camera: ReturnType<typeof useWorkspaceCamera> | null = null;

  function Harness() {
    flow = useStoreApi();
    camera = useWorkspaceCamera({
      isCanvasPlaced: () => true,
      paintedNodes: useAtomValue(canvasNodesAtom),
      revealOccupiedWidth: options.revealOccupiedWidth ?? 0,
    });
    return null;
  }

  render(
    <JotaiProvider store={store}>
      <ReactFlowProvider
        initialHeight={CANVAS.height}
        initialWidth={CANVAS.width}
      >
        <Harness />
      </ReactFlowProvider>
    </JotaiProvider>
  );

  const flowState = () => {
    if (!flow) {
      throw new Error("the React Flow store did not mount");
    }
    return flow;
  };
  flowState().setState({
    panZoom: {
      setViewport: vi.fn(async (viewport: Viewport) => {
        moves.push(viewport);
        flowState().setState({
          transform: [viewport.x, viewport.y, viewport.zoom],
        });
        return { k: viewport.zoom, x: viewport.x, y: viewport.y };
      }),
    } as unknown as ReactFlowState["panZoom"],
  });

  return {
    store,
    moves,
    flow: flowState,
    show: async (search: WorkflowRouteSearch) => {
      await act(async () => {
        showWorkspaceRoute(store, search);
      });
    },
    /** A person panning to `viewport`, ending the move. */
    pan: async (viewport: Viewport) => {
      await act(async () => {
        flowState().setState({
          transform: [viewport.x, viewport.y, viewport.zoom],
        });
        camera?.onMoveEnd();
      });
    },
    /**
     * Happy-dom's media query listener starts out believing the query does not
     * match, so the first move below `md` from a wide viewport reports no
     * change. One narrow and wide round trip puts the listener in step.
     */
    settleViewportListener: async () => {
      await act(async () => {
        setViewportWidth(390);
        setViewportWidth(1440);
      });
    },
    /** The media query answering for a window `width` pixels wide. */
    resizeWindow: async (width: number) => {
      await act(async () => {
        setViewportWidth(width);
      });
    },
    /**
     * React Flow measuring the canvas at `size`, which a browser reports after
     * the media query.
     */
    measureCanvas: async (size: CanvasSize) => {
      await act(async () => {
        flowState().setState(size);
      });
    },
    /**
     * The media query and React Flow's canvas size changing in one commit, as
     * a browser delivers them when the window jumps between layouts.
     */
    resizeAndMeasure: async (width: number, size: CanvasSize) => {
      await act(async () => {
        setViewportWidth(width);
        flowState().setState(size);
      });
    },
    viewport: (): Viewport => {
      const [x, y, zoom] = flowState().getState().transform;
      return { x, y, zoom };
    },
  };
}

beforeEach(() => {
  setViewportWidth(1440);
});

/** Whether any part of `node`'s card is inside `canvas` at `viewport`. */
function onScreen(
  node: WorkflowNode,
  viewport: Viewport,
  canvas: CanvasSize = CANVAS
): boolean {
  const left = node.position.x * viewport.zoom + viewport.x;
  const top = node.position.y * viewport.zoom + viewport.y;
  const width = (node.width ?? 0) * viewport.zoom;
  const height = (node.height ?? 0) * viewport.zoom;
  return (
    left < canvas.width &&
    left + width > 0 &&
    top < canvas.height &&
    top + height > 0
  );
}

describe("useWorkspaceCamera across Group scopes", () => {
  it("fits a first visit, then restores the overview and the Group separately", async () => {
    const camera = renderCamera();
    await camera.pan({ x: -100, y: -50, zoom: 0.8 });

    await camera.show({ group: "g" });
    expect(camera.moves).toHaveLength(1);
    const members = camera.store.get(canvasNodesAtom);
    expect(members.every((node) => onScreen(node, camera.viewport()))).toBe(
      true
    );
    await camera.pan({ x: 300, y: 200, zoom: 1.2 });

    await camera.show({});
    expect(camera.viewport().x).toBeCloseTo(-100);
    expect(camera.viewport().y).toBeCloseTo(-50);
    expect(camera.viewport().zoom).toBeCloseTo(0.8);

    await camera.show({ group: "g" });
    expect(camera.viewport().x).toBeCloseTo(300);
    expect(camera.viewport().y).toBeCloseTo(200);
    expect(camera.viewport().zoom).toBeCloseTo(1.2);
  });

  it("fits a first visit beside an open Reveal in one placement", async () => {
    // Browse on a 1200px canvas takes 360px and its 8px inset.
    const camera = renderCamera({ revealOccupiedWidth: 368 });
    const motion = recordCameraMotion(camera.flow());
    const start = camera.viewport();

    await camera.show({ group: "g" });

    expectSteadyCamera(motion.moves, start);
    const usable = { width: CANVAS.width - 368, height: CANVAS.height };
    const members = camera.store.get(canvasNodesAtom);
    expect(members.length).toBeGreaterThan(0);
    expect(
      members.every((node) => {
        const viewport = camera.viewport();
        const right =
          (node.position.x + (node.width ?? 0)) * viewport.zoom + viewport.x;
        return onScreen(node, viewport, usable) && right <= usable.width;
      })
    ).toBe(true);
  });

  it("keeps the focused camera on the members after the collapsed card moves", async () => {
    const camera = renderCamera();
    await camera.show({ group: "g" });
    const focused = camera.store.get(canvasNodesAtom);
    const saved = camera.viewport();
    await camera.pan(saved);

    await camera.show({});
    await act(async () => {
      camera.store.set(onNodesChangeAtom, [
        { type: "position", id: "g", position: { x: 2400, y: 1800 } },
      ]);
    });
    await camera.show({ group: "g" });

    expect(
      camera.store.get(canvasNodesAtom).map((node) => node.position)
    ).toEqual(focused.map((node) => node.position));
    expect(camera.viewport()).toEqual(saved);
    expect(
      camera.store
        .get(canvasNodesAtom)
        .every((node) => onScreen(node, camera.viewport()))
    ).toBe(true);
  });

  it("leaves a workspace switch with no saved camera to the canvas", async () => {
    const camera = renderCamera();
    await camera.show({ view: "runs" });
    expect(camera.moves).toEqual([]);
  });
});

describe("useWorkspaceCamera across a form factor change", () => {
  const expectViewport = (actual: Viewport, expected: Viewport) => {
    expect(actual.x).toBeCloseTo(expected.x);
    expect(actual.y).toBeCloseTo(expected.y);
    expect(actual.zoom).toBeCloseTo(expected.zoom);
  };

  it("fits the overview on a first phone visit once the phone canvas is measured", async () => {
    const camera = renderCamera();
    await camera.settleViewportListener();
    await camera.pan({ x: 5000, y: 3000, zoom: 1 });

    await camera.resizeWindow(393);
    await camera.measureCanvas(PHONE_CANVAS);

    expect(
      camera.store
        .get(canvasNodesAtom)
        .every((node) => onScreen(node, camera.viewport(), PHONE_CANVAS))
    ).toBe(true);
  });

  it("restores each form factor's camera when the new canvas size arrives after the form factor", async () => {
    const camera = renderCamera();
    await camera.settleViewportListener();
    const desktop = { x: 500, y: 300, zoom: 1 };
    await camera.pan(desktop);
    await camera.resizeWindow(393);
    await camera.measureCanvas(PHONE_CANVAS);
    const phone = { x: 40, y: 120, zoom: 0.6 };
    await camera.pan(phone);

    await camera.resizeWindow(1440);
    await camera.measureCanvas(CANVAS);
    expectViewport(camera.viewport(), desktop);

    await camera.resizeWindow(393);
    await camera.measureCanvas(PHONE_CANVAS);
    expectViewport(camera.viewport(), phone);
  });

  it("restores each form factor's camera when the new canvas size arrives with the form factor", async () => {
    const camera = renderCamera();
    await camera.settleViewportListener();
    const desktop = { x: 500, y: 300, zoom: 1 };
    await camera.pan(desktop);
    await camera.resizeAndMeasure(393, PHONE_CANVAS);
    const phone = { x: 40, y: 120, zoom: 0.6 };
    await camera.pan(phone);

    await camera.resizeAndMeasure(1440, CANVAS);
    expectViewport(camera.viewport(), desktop);

    await camera.resizeAndMeasure(393, PHONE_CANVAS);
    expectViewport(camera.viewport(), phone);
  });
});
