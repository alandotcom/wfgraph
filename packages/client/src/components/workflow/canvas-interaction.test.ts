import { describe, expect, it } from "vitest";
import { canvasInteractionState } from "./canvas-interaction";

const EDITABLE = {
  editingLocked: false,
  comparisonActive: false,
  overlayActive: false,
  topologyAuthoring: true,
};

describe("canvasInteractionState", () => {
  it("keeps comparison nodes selectable and enables only their node-level drag flags", () => {
    expect(
      canvasInteractionState({
        ...EDITABLE,
        editingLocked: true,
        comparisonActive: true,
      })
    ).toEqual({
      comparisonVisible: true,
      insertsNodes: false,
      editsTopology: false,
      elementsSelectable: true,
      nodesDraggable: true,
      edgesFocusable: false,
      deleteKeyCode: null,
      multiSelectionKeyCode: ["Meta", "Control", "Shift"],
      selectionKeyCode: "Shift",
    });
  });

  it("keeps a visible run overlay ahead of an active comparison", () => {
    expect(
      canvasInteractionState({
        ...EDITABLE,
        editingLocked: true,
        comparisonActive: true,
        overlayActive: true,
      })
    ).toEqual({
      comparisonVisible: false,
      insertsNodes: false,
      editsTopology: false,
      elementsSelectable: false,
      nodesDraggable: false,
      edgesFocusable: true,
      deleteKeyCode: ["Backspace", "Delete"],
      multiSelectionKeyCode: ["Meta", "Control", "Shift"],
      selectionKeyCode: "Shift",
    });
  });

  it("inserts nodes on an editable canvas, including a focused Group", () => {
    expect(canvasInteractionState(EDITABLE).insertsNodes).toBe(true);
    expect(
      canvasInteractionState({ ...EDITABLE, editingLocked: true }).insertsNodes
    ).toBe(false);
  });

  it("offers selection alone without topology authoring", () => {
    for (const comparisonActive of [false, true]) {
      expect(
        canvasInteractionState({
          ...EDITABLE,
          comparisonActive,
          topologyAuthoring: false,
        })
      ).toMatchObject({
        insertsNodes: false,
        editsTopology: false,
        elementsSelectable: true,
        nodesDraggable: false,
        deleteKeyCode: null,
        multiSelectionKeyCode: null,
        selectionKeyCode: null,
      });
    }
  });
});
