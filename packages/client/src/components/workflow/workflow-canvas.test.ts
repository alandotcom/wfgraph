import { describe, expect, it } from "vitest";
import {
  canvasFitViewKey,
  canvasInteractionState,
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
  it("changes with the workspace and lifecycle position", () => {
    const draft = canvasFitViewKey({
      workflowId: "workflow_1",
      workspaceView: "draft",
      lifecycleNode: { id: "lifecycle", position: { x: 100, y: 20 } },
    });
    const runs = canvasFitViewKey({
      workflowId: "workflow_1",
      workspaceView: "runs",
      lifecycleNode: { id: "lifecycle", position: { x: 100, y: 20 } },
    });
    const moved = canvasFitViewKey({
      workflowId: "workflow_1",
      workspaceView: "runs",
      lifecycleNode: { id: "lifecycle", position: { x: 140, y: 20 } },
    });

    expect(runs).not.toBe(draft);
    expect(moved).not.toBe(runs);
  });

  it("waits for both a workflow and lifecycle node", () => {
    expect(
      canvasFitViewKey({
        workflowId: null,
        workspaceView: "draft",
        lifecycleNode: { id: "lifecycle", position: { x: 0, y: 0 } },
      })
    ).toBeNull();
    expect(
      canvasFitViewKey({
        workflowId: "workflow_1",
        workspaceView: "draft",
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
