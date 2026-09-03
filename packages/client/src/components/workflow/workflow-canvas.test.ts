import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { canvasNodeWithInitialDimensions } from "#src/components/workflow/workflow-canvas-accessibility";
import {
  canvasFitViewKey,
  canvasSynchronizationKey,
  fitInitialWorkflowViewport,
  keyboardFitViewOptions,
  lifecycleAnchorViewport,
  synchronizeCanvasGraph,
  synchronizedLifecycleAnchor,
  useFitAgentGraph,
  useSynchronizedCanvas,
} from "#src/components/workflow/workflow-canvas-synchronization";
import { canvasInteractionState } from "#src/components/workflow/workflow-canvas";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

function lifecycleNode(x: number): WorkflowNode {
  return {
    id: "lifecycle",
    type: "lifecycle",
    position: { x, y: 20 },
    data: { label: "Lifecycle", type: "lifecycle" },
  };
}

describe("canvasNodeWithInitialDimensions", () => {
  it("keeps an unmeasured replacement node visible while React Flow installs it", () => {
    const node = lifecycleNode(0);

    expect(canvasNodeWithInitialDimensions(node)).toEqual({
      ...node,
      initialWidth: 192,
      initialHeight: 112,
    });
  });

  it("preserves a dynamic node's known dimensions", () => {
    const node = {
      ...lifecycleNode(0),
      width: 396,
      height: 248,
    };

    expect(canvasNodeWithInitialDimensions(node)).toEqual({
      ...node,
      initialWidth: 396,
      initialHeight: 248,
    });
  });

  it("preserves the dimensioned node identity across presentation updates", () => {
    const node = lifecycleNode(0);

    expect(canvasNodeWithInitialDimensions(node)).toBe(
      canvasNodeWithInitialDimensions(node)
    );
  });
});

describe("synchronizeCanvasGraph", () => {
  it("installs a replacement graph before the workspace can paint", () => {
    const outgoingNodes = [lifecycleNode(500)];
    const incomingNodes = [lifecycleNode(0)];
    const outgoingEdges: WorkflowEdge[] = [];
    const incomingEdges: WorkflowEdge[] = [];
    let currentNodes = outgoingNodes;
    let currentEdges = outgoingEdges;

    synchronizeCanvasGraph({
      nodes: incomingNodes,
      edges: incomingEdges,
      currentNodes,
      currentEdges,
      setNodes: (nodes) => {
        currentNodes = nodes;
      },
      setEdges: (edges) => {
        currentEdges = edges;
      },
    });

    expect(currentNodes).toBe(incomingNodes);
    expect(currentEdges).toBe(incomingEdges);
  });
});

describe("useSynchronizedCanvas", () => {
  it("does not set the viewport when lifecycle moves within the draft presentation", () => {
    const draftPresentation = {};
    const setViewport = vi.fn();
    const initial = lifecycleNode(100);
    const internalNode = (userNode: WorkflowNode) => ({
      userNode,
      position: userNode.position,
      width: 192,
    });
    const { rerender } = renderHook(
      ({ lifecycle, presentation }) =>
        useSynchronizedCanvas({
          presentation,
          synchronizePresentation: () => {
            setViewport({ x: -lifecycle.position.x, y: 0, zoom: 1 });
          },
          currentWorkflowId: "workflow_1",
          lifecycleNode: lifecycle,
          internalNode: internalNode(lifecycle),
          fitGenerationRef: { current: 0 },
        }),
      {
        initialProps: { lifecycle: initial, presentation: draftPresentation },
      }
    );
    setViewport.mockClear();

    rerender({
      lifecycle: lifecycleNode(500),
      presentation: draftPresentation,
    });

    expect(setViewport).not.toHaveBeenCalled();
  });

  it("sets the viewport when the canvas presentation is replaced", () => {
    const lifecycle = lifecycleNode(100);
    const setViewport = vi.fn();
    const { rerender } = renderHook(
      ({ presentation }) =>
        useSynchronizedCanvas({
          presentation,
          synchronizePresentation: setViewport,
          currentWorkflowId: "workflow_1",
          lifecycleNode: lifecycle,
          internalNode: {
            userNode: lifecycle,
            position: lifecycle.position,
            width: 192,
          },
          fitGenerationRef: { current: 0 },
        }),
      { initialProps: { presentation: {} } }
    );
    setViewport.mockClear();

    rerender({ presentation: {} });

    expect(setViewport).toHaveBeenCalledOnce();
  });
});

describe("canvasSynchronizationKey", () => {
  it("synchronizes again when same-workflow hydration replaces the Draft edges", () => {
    const lifecycle = lifecycleNode(100);
    const synchronizePresentation = vi.fn();
    const runGraph = {
      nodes: [lifecycleNode(500)],
      edges: [{ id: "run-edge", source: "lifecycle", target: "run-action" }],
    };
    const initialDraftEdges: WorkflowEdge[] = [
      { id: "draft-edge", source: "lifecycle", target: "draft-action" },
    ];
    const hydratedDraftEdges = initialDraftEdges.map((edge) => ({ ...edge }));
    type Props = {
      workspaceView: "draft" | "runs";
      executionOverlay: unknown;
      draftEdges: WorkflowEdge[];
    };
    const { rerender } = renderHook(
      ({ workspaceView, executionOverlay, draftEdges }: Props) =>
        useSynchronizedCanvas({
          presentation: canvasSynchronizationKey({
            workspaceView,
            executionOverlay,
            comparison: null,
            draftEdges,
          }),
          synchronizePresentation,
          currentWorkflowId: "workflow_1",
          lifecycleNode: lifecycle,
          internalNode: {
            userNode: lifecycle,
            position: lifecycle.position,
            width: 192,
          },
          fitGenerationRef: { current: 0 },
        }),
      {
        initialProps: {
          workspaceView: "runs",
          executionOverlay: runGraph,
          draftEdges: initialDraftEdges,
        },
      }
    );
    synchronizePresentation.mockClear();

    rerender({
      workspaceView: "draft",
      executionOverlay: null,
      draftEdges: initialDraftEdges,
    });
    expect(synchronizePresentation).toHaveBeenCalledOnce();
    synchronizePresentation.mockClear();

    rerender({
      workspaceView: "draft",
      executionOverlay: null,
      draftEdges: hydratedDraftEdges,
    });
    expect(synchronizePresentation).toHaveBeenCalledOnce();
    synchronizePresentation.mockClear();

    // Node dragging retains the edge array, so an otherwise identical render
    // does not trigger presentation synchronization.
    rerender({
      workspaceView: "draft",
      executionOverlay: null,
      draftEdges: hydratedDraftEdges,
    });
    expect(synchronizePresentation).not.toHaveBeenCalled();
  });
});

describe("canvasInteractionState", () => {
  it("keeps comparison nodes selectable and enables only their node-level drag flags", () => {
    expect(
      canvasInteractionState({
        editingLocked: true,
        comparisonActive: true,
        overlayActive: false,
      })
    ).toEqual({
      comparisonVisible: true,
      elementsSelectable: true,
      nodesDraggable: true,
      edgesFocusable: false,
      deleteKeyCode: null,
    });
  });

  it("keeps a visible run overlay ahead of an active comparison", () => {
    expect(
      canvasInteractionState({
        editingLocked: true,
        comparisonActive: true,
        overlayActive: true,
      })
    ).toEqual({
      comparisonVisible: false,
      elementsSelectable: false,
      nodesDraggable: false,
      edgesFocusable: true,
      deleteKeyCode: ["Backspace", "Delete"],
    });
  });
});

describe("canvasFitViewKey", () => {
  it("ignores workspace-only changes but changes with the lifecycle anchor", () => {
    const draft = canvasFitViewKey({
      workflowId: "workflow_1",
      lifecycleNode: { id: "lifecycle", position: { x: 100, y: 20 } },
    });
    const runs = canvasFitViewKey({
      workflowId: "workflow_1",
      lifecycleNode: { id: "lifecycle", position: { x: 100, y: 20 } },
    });
    const moved = canvasFitViewKey({
      workflowId: "workflow_1",
      lifecycleNode: { id: "lifecycle", position: { x: 140, y: 20 } },
    });

    expect(runs).toBe(draft);
    expect(moved).not.toBe(runs);
  });

  it("waits for both a workflow and lifecycle node", () => {
    expect(
      canvasFitViewKey({
        workflowId: null,
        lifecycleNode: { id: "lifecycle", position: { x: 0, y: 0 } },
      })
    ).toBeNull();
    expect(
      canvasFitViewKey({
        workflowId: "workflow_1",
        lifecycleNode: null,
      })
    ).toBeNull();
  });
});

describe("lifecycleAnchorViewport", () => {
  it("places the lifecycle at the top center without changing zoom", () => {
    expect(
      lifecycleAnchorViewport({
        canvasWidth: 1000,
        nodePosition: { x: 200, y: 80 },
        nodeWidth: 192,
        top: 48,
        zoom: 0.75,
      })
    ).toEqual({ x: 278, y: -12, zoom: 0.75 });
  });
});

describe("synchronizedLifecycleAnchor", () => {
  it("waits for React Flow's internal node before anchoring a replacement graph", () => {
    const outgoing = lifecycleNode(100);
    const incoming = lifecycleNode(500);

    expect(
      synchronizedLifecycleAnchor(incoming, {
        userNode: outgoing,
        position: outgoing.position,
        width: 192,
      })
    ).toBeNull();

    expect(
      synchronizedLifecycleAnchor(incoming, {
        userNode: incoming,
        position: incoming.position,
        width: 192,
      })
    ).toEqual({ id: "lifecycle", position: { x: 500, y: 20 }, width: 192 });
  });
});

describe("useSynchronizedCanvas lifecycle anchor", () => {
  it("waits to expose the incoming anchor until React Flow installs the replacement", () => {
    const outgoing = lifecycleNode(100);
    const incoming = lifecycleNode(500);
    const fitGenerationRef = { current: 0 };
    const internalNode = (userNode: WorkflowNode) => ({
      userNode,
      position: userNode.position,
      width: 192,
    });
    const { result, rerender } = renderHook(
      ({ displayedNode, installedNode }) =>
        useSynchronizedCanvas({
          presentation: {},
          synchronizePresentation: () => {},
          currentWorkflowId: "workflow_1",
          lifecycleNode: displayedNode,
          internalNode: installedNode,
          fitGenerationRef,
        }),
      {
        initialProps: {
          displayedNode: outgoing,
          installedNode: internalNode(outgoing),
        },
      }
    );

    rerender({
      displayedNode: incoming,
      installedNode: internalNode(outgoing),
    });
    expect(result.current.lifecycleAnchor).toBeNull();

    rerender({
      displayedNode: incoming,
      installedNode: internalNode(incoming),
    });
    expect(result.current.lifecycleAnchor).toEqual({
      id: "lifecycle",
      position: { x: 500, y: 20 },
      width: 192,
    });
  });
});

describe("useFitAgentGraph", () => {
  it("fits only new agent updates for the open workflow", async () => {
    vi.useFakeTimers();
    try {
      const fitView = vi.fn(async () => true);
      const fitGenerationRef = { current: 0 };
      const { rerender } = renderHook(
        ({ update, workflowId }) =>
          useFitAgentGraph({
            update,
            workflowId,
            beforeFit: () => {
              fitGenerationRef.current += 1;
            },
            fitView,
          }),
        {
          initialProps: {
            update: { workflowId: "workflow-a", revision: 1 },
            workflowId: "workflow-a",
          },
        }
      );

      await act(() => vi.runAllTimersAsync());
      expect(fitView).not.toHaveBeenCalled();

      rerender({
        update: { workflowId: "workflow-a", revision: 2 },
        workflowId: "workflow-a",
      });
      await act(() => vi.runAllTimersAsync());

      expect(fitView).toHaveBeenCalledOnce();
      expect(fitGenerationRef.current).toBe(1);

      rerender({
        update: { workflowId: "workflow-a", revision: 3 },
        workflowId: "workflow-b",
      });
      await act(() => vi.runAllTimersAsync());

      expect(fitView).toHaveBeenCalledOnce();

      rerender({
        update: { workflowId: "workflow-b", revision: 4 },
        workflowId: "workflow-b",
      });
      await act(() => vi.runAllTimersAsync());

      expect(fitView).toHaveBeenCalledTimes(2);
      expect(fitGenerationRef.current).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fitInitialWorkflowViewport", () => {
  it("abandons viewport anchoring and readiness when the fit becomes stale", async () => {
    let resolveFit = () => {};
    let current = true;
    const fitView = () =>
      new Promise<boolean>((resolve) => {
        resolveFit = () => resolve(true);
      });
    let viewportWasSet = false;
    let canvasWasRevealed = false;

    const fitting = fitInitialWorkflowViewport({
      fitView,
      isCurrent: () => current,
      readAnchor: () => ({
        canvasWidth: 1000,
        nodePosition: { x: 200, y: 80 },
        nodeWidth: 192,
        zoom: 0.75,
      }),
      setViewport: async () => {
        viewportWasSet = true;
        return true;
      },
      reveal: () => {
        canvasWasRevealed = true;
      },
    });

    current = false;
    resolveFit();
    await fitting;

    expect(viewportWasSet).toBe(false);
    expect(canvasWasRevealed).toBe(false);
  });
});

describe("keyboardFitViewOptions", () => {
  it("fits immediately for the keyboard shortcut", () => {
    expect(keyboardFitViewOptions).toEqual({ padding: 0.2, duration: 0 });
  });
});
