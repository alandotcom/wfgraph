import { describe, expect, it } from "vitest";
import {
  canvasFitViewKey,
  canvasInteractionState,
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
  it("changes when comparison activates or its base revision changes", () => {
    const draft = canvasFitViewKey({
      workflowId: "workflow_1",
      comparisonBaseVersionId: null,
      comparisonVisible: false,
      overlayActive: false,
    });
    const firstBase = canvasFitViewKey({
      workflowId: "workflow_1",
      comparisonBaseVersionId: "version_1",
      comparisonVisible: true,
      overlayActive: false,
    });
    const nextBase = canvasFitViewKey({
      workflowId: "workflow_1",
      comparisonBaseVersionId: "version_2",
      comparisonVisible: true,
      overlayActive: false,
    });

    expect(firstBase).not.toBe(draft);
    expect(nextBase).not.toBe(firstBase);
    expect(
      canvasFitViewKey({
        workflowId: "workflow_1",
        comparisonBaseVersionId: "version_2",
        comparisonVisible: true,
        overlayActive: false,
      })
    ).toBe(nextBase);
  });

  it("keeps the workflow key while an execution overlay has precedence", () => {
    expect(
      canvasFitViewKey({
        workflowId: "workflow_1",
        comparisonBaseVersionId: "version_2",
        comparisonVisible: false,
        overlayActive: true,
      })
    ).toBe("workflow_1");
  });
});
