import { act, render } from "@testing-library/react";
import {
  ReactFlowProvider,
  type ReactFlowState,
  useStoreApi,
} from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  workspaceAddressFromSearch,
  workspaceAddressId,
} from "#src/lib/workflow-navigation-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { showCanvasRevealLevelAtom } from "./canvas-reveal-state";
import { requestRevealPlacementAtom } from "./reveal-requests";
import { useRevealCamera } from "./use-reveal-camera";

const CANVAS = { width: 1200, height: 800 };

function step(id: string, x: number, y: number): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x, y },
    width: 200,
    height: 80,
    data: { label: id, type: "action", config: { actionType: "mailer/send" } },
  };
}

const NODES = [step("near", 100, 300), step("far", 1100, 300)];

type Viewport = { x: number; y: number; zoom: number };

/** Happy-dom's viewport, which the `md` media query answers from. */
function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

/**
 * The hook inside a real React Flow store. `panZoom` is a stub that records each
 * `setViewport` and, unless `animating` holds it, applies the viewport at once
 * the way a finished animation does.
 */
function renderCamera() {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(loadWorkflowGraphAtom, { nodes: NODES, edges: [] });
  showWorkspaceRoute(store, {});

  const moves: Viewport[] = [];
  const controls = { animating: false };
  let flow: {
    getState: () => ReactFlowState;
    setState: (state: Partial<ReactFlowState>) => void;
  } | null = null;
  let onMoveEnd = () => undefined as void;

  function Harness() {
    const canvas = useRef<HTMLDivElement>(null);
    const flowStore = useStoreApi();
    flow = flowStore;
    const camera = useRevealCamera({
      isCanvasPlaced: () => true,
      isCanvasReady: true,
      canvas,
    });
    onMoveEnd = camera.onMoveEnd;
    return <div ref={canvas} />;
  }

  render(
    <JotaiProvider store={store}>
      <ReactFlowProvider
        initialHeight={CANVAS.height}
        initialNodes={NODES}
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
        if (!controls.animating) {
          flowState().setState({
            transform: [viewport.x, viewport.y, viewport.zoom],
          });
        }
        return { k: viewport.zoom, x: viewport.x, y: viewport.y };
      }),
    } as unknown as ReactFlowState["panZoom"],
  });

  /** Let the hook's after-paint work run. */
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const run = async (write: () => void) => {
    await act(async () => {
      write();
    });
    await settle();
  };

  return {
    store,
    moves,
    controls,
    run,
    settle,
    /** A person panning to `viewport`, ending the move. */
    pan: async (viewport: Viewport) => {
      await act(async () => {
        flowState().setState({
          transform: [viewport.x, viewport.y, viewport.zoom],
        });
        onMoveEnd();
      });
    },
    /** The animation the hook started reaching its target. */
    finishAnimation: async () => {
      const last = moves.at(-1);
      await act(async () => {
        if (last) {
          flowState().setState({ transform: [last.x, last.y, last.zoom] });
        }
        onMoveEnd();
      });
    },
    setSize: async (size: { width: number; height: number }) => {
      await act(async () => {
        flowState().setState(size);
      });
      await settle();
    },
  };
}

beforeEach(() => {
  setViewportWidth(1440);
});

describe("useRevealCamera", () => {
  it("leaves a step that already fits where it is", async () => {
    const camera = renderCamera();
    await camera.settle();
    await camera.run(() => camera.store.set(selectOnlyNodeAtom, "near"));
    expect(camera.moves).toEqual([]);
  });

  it("moves a step under Reveal the least distance, then restores on close", async () => {
    const camera = renderCamera();
    await camera.settle();
    await camera.run(() => camera.store.set(selectOnlyNodeAtom, "far"));

    // Browse on a 1200px canvas takes 360px and the 8px inset. The step's right
    // edge and 64px of context end at 1364px, and the usable edge less 24px of
    // padding is at 808px.
    expect(camera.moves).toHaveLength(1);
    expect(camera.moves[0]?.x).toBeCloseTo(-556);
    expect(camera.moves[0]?.y).toBeCloseTo(0);
    expect(camera.moves[0]?.zoom).toBe(1);

    await camera.run(() =>
      camera.store.set(showCanvasRevealLevelAtom, "closed")
    );
    expect(camera.moves).toHaveLength(2);
    expect(camera.moves[1]?.x).toBeCloseTo(0);
  });

  it("keeps a camera a person moved when Reveal closes", async () => {
    const camera = renderCamera();
    await camera.settle();
    await camera.run(() => camera.store.set(selectOnlyNodeAtom, "far"));
    await camera.pan({ x: -700, y: 40, zoom: 1 });

    await camera.run(() =>
      camera.store.set(showCanvasRevealLevelAtom, "closed")
    );
    expect(camera.moves).toHaveLength(1);
  });

  it("restores the camera from before Reveal while its placement is still animating", async () => {
    const camera = renderCamera();
    await camera.settle();
    camera.controls.animating = true;
    await camera.run(() => camera.store.set(selectOnlyNodeAtom, "far"));
    expect(camera.moves).toHaveLength(1);

    await camera.run(() =>
      camera.store.set(showCanvasRevealLevelAtom, "closed")
    );
    expect(camera.moves).toHaveLength(2);
    expect(camera.moves[1]?.x).toBeCloseTo(0);
  });

  it("acts on a level change made while the canvas had no size", async () => {
    const camera = renderCamera();
    await camera.settle();
    await camera.run(() => camera.store.set(selectOnlyNodeAtom, "far"));
    await camera.finishAnimation();
    await camera.setSize({ width: 0, height: 0 });

    await camera.run(() =>
      camera.store.set(showCanvasRevealLevelAtom, "focus")
    );
    expect(camera.moves).toHaveLength(1);

    await camera.setSize(CANVAS);
    expect(camera.moves).toHaveLength(2);
  });

  it("fits the whole graph beside the Runs panel when no node is selected", async () => {
    const camera = renderCamera();
    await camera.settle();
    await camera.run(() =>
      camera.store.set(executionOverlayGraphAtom, { nodes: NODES, edges: [] })
    );
    await camera.run(() => showWorkspaceRoute(camera.store, { view: "runs" }));
    await camera.run(() =>
      camera.store.set(showCanvasRevealLevelAtom, "closed")
    );
    expect(camera.moves).toEqual([]);

    await camera.run(() =>
      camera.store.set(showCanvasRevealLevelAtom, "browse")
    );
    // The graph spans 1200px and the usable width less padding is 784px, so the
    // zoom decreases to fit it.
    expect(camera.moves).toHaveLength(1);
    expect(camera.moves[0]?.zoom).toBeCloseTo(784 / 1200);
  });

  it("answers a placement request once its address is shown", async () => {
    const camera = renderCamera();
    await camera.settle();
    const draftId = workspaceAddressId(workspaceAddressFromSearch("wf_1", {}));
    await camera.run(() => showWorkspaceRoute(camera.store, { view: "runs" }));
    await camera.run(() =>
      camera.store.set(requestRevealPlacementAtom, {
        addressId: draftId,
        nodeIds: ["far"],
      })
    );
    expect(camera.moves).toEqual([]);

    await camera.run(() => showWorkspaceRoute(camera.store, {}));
    expect(camera.moves).toHaveLength(1);
  });
});
