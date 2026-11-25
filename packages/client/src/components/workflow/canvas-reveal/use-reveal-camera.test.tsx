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
  clearSelectionAtom,
  loadWorkflowGraphAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  workspaceAddressFromSearch,
  workspaceAddressId,
} from "#src/lib/workflow-navigation-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { requestRevealPlacementAtom } from "./reveal-requests";
import { useRevealCamera } from "./use-reveal-camera";
import {
  expectSteadyCamera,
  recordCameraMotion,
} from "#src/components/workflow/camera-motion-test-support";

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
function renderCamera(
  graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] } = {
    nodes: NODES,
    edges: [],
  },
  options?: { flowNodes?: WorkflowNode[] }
) {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(loadWorkflowGraphAtom, graph);
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
        initialEdges={graph.edges}
        initialHeight={CANVAS.height}
        initialNodes={options?.flowNodes ?? graph.nodes}
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
  const motion = recordCameraMotion(flowState());

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
    motion,
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
    viewport: (): Viewport => {
      const [x, y, zoom] = flowState().getState().transform;
      return { x, y, zoom };
    },
    /** Replace the nodes React Flow holds, as the canvas does on a repaint. */
    setFlowNodes: (nodes: WorkflowNode[]) => {
      flowState().getState().setNodes(nodes);
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
  it("moves nothing when a step is selected or deselected, even one off screen", async () => {
    const camera = renderCamera();
    await camera.settle();
    await camera.run(() => camera.store.set(selectOnlyNodeAtom, "far"));
    await camera.run(() => camera.store.set(selectOnlyNodeAtom, "near"));
    await camera.run(() => camera.store.set(clearSelectionAtom));

    expect(camera.moves).toEqual([]);
    expect(camera.motion.moves).toEqual([]);
  });

  it("moves a requested step that is off screen the least distance, once", async () => {
    const camera = renderCamera();
    await camera.settle();
    const addressId = workspaceAddressId(
      camera.store.get(activeWorkspaceAddressAtom)
    );
    await camera.run(() =>
      camera.store.set(requestRevealPlacementAtom, {
        addressId,
        nodeIds: ["far"],
      })
    );

    // The step's right edge and 64px of context end at 1364px, and the
    // canvas edge less 24px of padding is at 1176px.
    expect(camera.moves).toHaveLength(1);
    expect(camera.moves[0]?.x).toBeCloseTo(-188);
    expect(camera.moves[0]?.y).toBeCloseTo(0);
    expect(camera.moves[0]?.zoom).toBe(1);
    expectSteadyCamera(camera.motion.moves, { x: 0, y: 0, zoom: 1 });

    // The same request again finds the step in view.
    await camera.run(() =>
      camera.store.set(requestRevealPlacementAtom, {
        addressId,
        nodeIds: ["far"],
      })
    );
    expect(camera.moves).toHaveLength(1);
  });

  it("leaves a requested step that is already in view where it is", async () => {
    const camera = renderCamera();
    await camera.settle();
    await camera.run(() =>
      camera.store.set(requestRevealPlacementAtom, {
        addressId: workspaceAddressId(
          camera.store.get(activeWorkspaceAddressAtom)
        ),
        nodeIds: ["near"],
      })
    );
    expect(camera.moves).toEqual([]);
  });

  it("answers a request for another address once that address shows", async () => {
    const camera = renderCamera();
    await camera.settle();
    const group = workspaceAddressFromSearch("wf_1", { group: "group_1" });
    await camera.run(() =>
      camera.store.set(requestRevealPlacementAtom, {
        addressId: workspaceAddressId(group),
        nodeIds: ["far"],
      })
    );
    expect(camera.moves).toEqual([]);

    await camera.run(() =>
      showWorkspaceRoute(camera.store, { group: "group_1" })
    );
    expect(camera.moves).toHaveLength(1);
  });

  it("places nothing on a phone", async () => {
    setViewportWidth(500);
    const camera = renderCamera();
    await camera.settle();
    await camera.run(() =>
      camera.store.set(requestRevealPlacementAtom, {
        addressId: workspaceAddressId(
          camera.store.get(activeWorkspaceAddressAtom)
        ),
        nodeIds: ["far"],
      })
    );
    expect(camera.moves).toEqual([]);
  });
});
