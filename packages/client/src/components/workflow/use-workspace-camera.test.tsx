import { act, render } from "@testing-library/react";
import {
  ReactFlowProvider,
  type ReactFlowState,
  useStoreApi,
} from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { useWorkspaceCamera } from "./use-workspace-camera";

const DESKTOP_CANVAS = { width: 1200, height: 800 };
const PHONE_CANVAS = { width: 393, height: 700 };

const GRAPH_NODES: WorkflowNode[] = [
  {
    id: "trigger",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    width: 192,
    height: 64,
    data: { label: "Trigger", type: "lifecycle" },
  },
  {
    id: "action",
    type: "action",
    position: { x: 0, y: 160 },
    width: 192,
    height: 64,
    data: { label: "Action", type: "action" },
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
 * The hook inside a real React Flow store holding `GRAPH_NODES`, whose
 * `panZoom` applies each `setViewport` at once. The media query and React
 * Flow's canvas size are driven separately, because a browser reports them at
 * different times.
 */
function renderCamera() {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");
  showWorkspaceRoute(store, {});

  let flow: {
    getState: () => ReactFlowState;
    setState: (state: Partial<ReactFlowState>) => void;
  } | null = null;
  let camera: ReturnType<typeof useWorkspaceCamera> | null = null;

  function Harness() {
    flow = useStoreApi();
    camera = useWorkspaceCamera({ isCanvasPlaced: () => true });
    return null;
  }

  render(
    <JotaiProvider store={store}>
      <ReactFlowProvider
        initialHeight={DESKTOP_CANVAS.height}
        initialNodes={GRAPH_NODES}
        initialWidth={DESKTOP_CANVAS.width}
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
        flowState().setState({
          transform: [viewport.x, viewport.y, viewport.zoom],
        });
        return { k: viewport.zoom, x: viewport.x, y: viewport.y };
      }),
    } as unknown as ReactFlowState["panZoom"],
  });

  return {
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
    /** React Flow measuring the canvas at `size`. */
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

/** Whether every node's card lies inside a `canvas` at `viewport`. */
function graphOnScreen(viewport: Viewport, canvas: CanvasSize): boolean {
  return GRAPH_NODES.every((node) => {
    const left = node.position.x * viewport.zoom + viewport.x;
    const top = node.position.y * viewport.zoom + viewport.y;
    const right = left + (node.width ?? 0) * viewport.zoom;
    const bottom = top + (node.height ?? 0) * viewport.zoom;
    return (
      left >= 0 && top >= 0 && right <= canvas.width && bottom <= canvas.height
    );
  });
}

function expectViewport(actual: Viewport, expected: Viewport): void {
  expect(actual.x).toBeCloseTo(expected.x);
  expect(actual.y).toBeCloseTo(expected.y);
  expect(actual.zoom).toBeCloseTo(expected.zoom);
}

describe("useWorkspaceCamera across a form factor change", () => {
  it("fits the graph on a first phone visit once the phone canvas is measured", async () => {
    const camera = renderCamera();
    await camera.settleViewportListener();
    await camera.pan({ x: 500, y: 300, zoom: 1 });

    await camera.resizeWindow(393);
    await camera.measureCanvas(PHONE_CANVAS);

    expect(graphOnScreen(camera.viewport(), PHONE_CANVAS)).toBe(true);
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
    await camera.measureCanvas(DESKTOP_CANVAS);
    expectViewport(camera.viewport(), desktop);

    await camera.resizeWindow(393);
    await camera.measureCanvas(PHONE_CANVAS);
    expectViewport(camera.viewport(), phone);
    expect(graphOnScreen(camera.viewport(), PHONE_CANVAS)).toBe(true);
  });

  it("restores each form factor's camera when the new canvas size arrives with the form factor", async () => {
    const camera = renderCamera();
    await camera.settleViewportListener();
    const desktop = { x: 500, y: 300, zoom: 1 };
    await camera.pan(desktop);
    await camera.resizeAndMeasure(393, PHONE_CANVAS);
    const phone = { x: 40, y: 120, zoom: 0.6 };
    await camera.pan(phone);

    await camera.resizeAndMeasure(1440, DESKTOP_CANVAS);
    expectViewport(camera.viewport(), desktop);

    await camera.resizeAndMeasure(393, PHONE_CANVAS);
    expectViewport(camera.viewport(), phone);
  });
});
