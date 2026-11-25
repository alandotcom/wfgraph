import { act, render } from "@testing-library/react";
import {
  getNodesBounds,
  getViewportForBounds,
  ReactFlowProvider,
  type ReactFlowState,
  useStoreApi,
} from "@xyflow/react";
import { createStore, Provider as JotaiProvider, useAtomValue } from "jotai";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canvasGraphAtom,
  displayNodesAtom,
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import {
  expectSteadyCamera,
  recordCameraMotion,
} from "./camera-motion-test-support";
import { REVEAL_PADDING_PX } from "./canvas-reveal/reveal-geometry";
import { useOpeningCamera } from "./use-opening-camera";
import {
  cardTierAtZoom,
  WORKFLOW_CANVAS_MIN_ZOOM,
  WORKFLOW_FIT_VIEW_MAX_ZOOM,
  WORKFLOW_FIT_VIEW_PADDING,
  WORKFLOW_NUMBER_CARD_ZOOM,
} from "./workflow-viewport";

const CANVAS = { width: 1200, height: 800 };

type Viewport = { x: number; y: number; zoom: number };

function card(
  id: string,
  x: number,
  y: number,
  options: { type?: string; parentId?: string } = {}
): WorkflowNode {
  return {
    id,
    type: options.type ?? "action",
    position: { x, y },
    width: 192,
    height: 112,
    ...(options.parentId ? { parentId: options.parentId } : {}),
    data: {
      label: id,
      type: options.type === "lifecycle" ? "lifecycle" : "action",
    },
  };
}

/**
 * A graph about as large as the seeded 16-step workflow: 1192 by 2112 flow
 * pixels, which fits a 1200 by 800 canvas only at about 0.3. "stop" sits at
 * the right edge, where open Canvas Reveal covers it once the Lifecycle card
 * is centered beside Reveal.
 */
const LARGE_GRAPH: WorkflowNode[] = [
  card("lifecycle", 500, 0, { type: "lifecycle" }),
  card("left", 0, 200),
  card("stop", 1000, 200),
  card("tail", 500, 2000),
];

/**
 * The zoom at which `LARGE_GRAPH` fits the canvas with Fit view's padding,
 * about 0.32. Its height decides it, so the same zoom fits beside open
 * Canvas Reveal.
 */
const LARGE_GRAPH_FITTED_ZOOM = getViewportForBounds(
  getNodesBounds(LARGE_GRAPH),
  CANVAS.width,
  CANVAS.height,
  WORKFLOW_CANVAS_MIN_ZOOM,
  WORKFLOW_FIT_VIEW_MAX_ZOOM,
  WORKFLOW_FIT_VIEW_PADDING
).zoom;

function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

/**
 * The hook inside a real React Flow store holding `nodes`, whose `panZoom`
 * records each `setViewport` and applies it at once, on the workspace address
 * `search` names.
 */
async function renderOpeningCamera(input: {
  nodes: WorkflowNode[];
  search: WorkflowRouteSearch;
  run?: { stoppedNodeId: string | null };
}) {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(loadWorkflowGraphAtom, { nodes: input.nodes, edges: [] });
  if (input.run) {
    store.set(executionOverlayGraphAtom, {
      nodes: input.nodes,
      edges: [],
      stoppedNodeId: input.run.stoppedNodeId,
    });
  }
  showWorkspaceRoute(store, input.search);

  let flow: {
    getState: () => ReactFlowState;
    setState: (state: Partial<ReactFlowState>) => void;
  } | null = null;
  let place: ReturnType<typeof useOpeningCamera> | null = null;
  let painted: WorkflowNode[] = [];

  function Harness() {
    const canvas = useRef<HTMLDivElement>(null);
    flow = useStoreApi();
    painted = useAtomValue(canvasGraphAtom).nodes;
    place = useOpeningCamera({
      canvas,
      paintedNodes: painted,
      graphNodes: useAtomValue(displayNodesAtom),
    });
    return <div ref={canvas} />;
  }

  render(
    <JotaiProvider store={store}>
      <ReactFlowProvider
        initialHeight={CANVAS.height}
        initialNodes={input.nodes}
        initialWidth={CANVAS.width}
      >
        <Harness />
      </ReactFlowProvider>
    </JotaiProvider>
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const flowState = () => {
    if (!flow) {
      throw new Error("the React Flow store did not mount");
    }
    return flow;
  };
  // React Flow holds the painted nodes, as the canvas installs them before it
  // places the camera.
  flowState().getState().setNodes(painted);
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
  const [x, y, zoom] = flowState().getState().transform;
  const start = { x, y, zoom };
  const motion = recordCameraMotion(flowState());

  return {
    start,
    motion,
    /** Open the workflow, or enter a view at `zoomLimit`, as the canvas does. */
    open: async (zoomLimit: number) => {
      const placeCamera = place;
      if (!placeCamera) {
        throw new Error("the hook did not mount");
      }
      await act(async () => {
        placeCamera({
          lifecycle: { nodePosition: { x: 500, y: 0 }, nodeWidth: 192 },
          zoomLimit,
        });
      });
    },
    viewport: (): Viewport => {
      const [vx, vy, vzoom] = flowState().getState().transform;
      return { x: vx, y: vy, zoom: vzoom };
    },
  };
}

/** The screen box of a flow-space card under `viewport`. */
function screenBox(node: WorkflowNode, viewport: Viewport) {
  const left = viewport.x + node.position.x * viewport.zoom;
  return {
    left,
    right: left + 192 * viewport.zoom,
    top: viewport.y + node.position.y * viewport.zoom,
  };
}

beforeEach(() => {
  setViewportWidth(1440);
});

describe("useOpeningCamera", () => {
  it("opens a large Draft on titled cards with the Lifecycle card at the top center, in one move", async () => {
    const camera = await renderOpeningCamera({
      nodes: LARGE_GRAPH,
      search: {},
    });

    await camera.open(WORKFLOW_FIT_VIEW_MAX_ZOOM);

    expectSteadyCamera(camera.motion.moves, camera.start);
    expect(camera.motion.moves).toHaveLength(1);
    const viewport = camera.viewport();
    // Fitting it whole would draw every card by number alone, so the camera
    // opens at the compact tier's lowest zoom and the graph runs off the
    // bottom edge.
    expect(LARGE_GRAPH_FITTED_ZOOM).toBeLessThan(WORKFLOW_NUMBER_CARD_ZOOM);
    expect(viewport.zoom).toBe(WORKFLOW_NUMBER_CARD_ZOOM);
    expect(cardTierAtZoom(viewport.zoom)).toBe("compact");
    const lifecycle = screenBox(LARGE_GRAPH[0], viewport);
    expect((lifecycle.left + lifecycle.right) / 2).toBeCloseTo(
      CANVAS.width / 2
    );
    expect(lifecycle.top).toBe(48);
  });

  it("places the step a failed run stopped at inside the canvas, in one move", async () => {
    const camera = await renderOpeningCamera({
      nodes: LARGE_GRAPH,
      search: { view: "runs", executionId: "run_1" },
      run: { stoppedNodeId: "stop" },
    });

    await camera.open(WORKFLOW_FIT_VIEW_MAX_ZOOM);

    expectSteadyCamera(camera.motion.moves, camera.start);
    expect(camera.motion.moves).toHaveLength(1);
    const viewport = camera.viewport();
    expect(viewport.zoom).toBe(WORKFLOW_NUMBER_CARD_ZOOM);
    const stopped = screenBox(LARGE_GRAPH[2], viewport);
    expect(stopped.left).toBeGreaterThanOrEqual(REVEAL_PADDING_PX);
    expect(stopped.right).toBeLessThanOrEqual(CANVAS.width - REVEAL_PADDING_PX);
  });

  it("anchors the Lifecycle card at the canvas center when the run did not stop", async () => {
    const camera = await renderOpeningCamera({
      nodes: LARGE_GRAPH,
      search: { view: "runs", executionId: "run_1" },
      run: { stoppedNodeId: null },
    });

    await camera.open(WORKFLOW_FIT_VIEW_MAX_ZOOM);

    expect(camera.motion.moves).toHaveLength(1);
    const viewport = camera.viewport();
    const lifecycle = screenBox(LARGE_GRAPH[0], viewport);
    expect((lifecycle.left + lifecycle.right) / 2).toBeCloseTo(
      CANVAS.width / 2
    );
  });

  it("keeps a lower zoom a view was entered at", async () => {
    const camera = await renderOpeningCamera({
      nodes: LARGE_GRAPH,
      search: { view: "runs", executionId: "run_1" },
      run: { stoppedNodeId: null },
    });

    // Below the zoom that fits the graph, about 0.32.
    await camera.open(0.25);

    expect(camera.viewport().zoom).toBe(0.25);
  });

  it("places a stopped step inside a collapsed Group by its Group card", async () => {
    const nodes: WorkflowNode[] = [
      card("lifecycle", 500, 0, { type: "lifecycle" }),
      card("left", 0, 200),
      card("group", 1000, 200, { type: "group" }),
      card("member", 12, 48, { parentId: "group" }),
      card("tail", 500, 2000),
    ];
    const camera = await renderOpeningCamera({
      nodes,
      search: { view: "runs", executionId: "run_1" },
      run: { stoppedNodeId: "member" },
    });

    await camera.open(WORKFLOW_FIT_VIEW_MAX_ZOOM);

    expect(camera.motion.moves).toHaveLength(1);
    const group = screenBox(nodes[2], camera.viewport());
    expect(group.right).toBeLessThanOrEqual(CANVAS.width - REVEAL_PADDING_PX);
  });
});
