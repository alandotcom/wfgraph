import { describe, expect, it } from "vitest";
import {
  canvasFitViewKey,
  canvasInteractionState,
  fitInitialWorkflowViewport,
  keyboardFitViewOptions,
  lifecycleAnchorViewport,
} from "#src/components/workflow/workflow-canvas";

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
