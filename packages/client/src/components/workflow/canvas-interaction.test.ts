import { describe, expect, it } from "vitest";
import { canvasInteractionState } from "./canvas-interaction";

const EDITABLE = {
  editingLocked: false,
  comparisonActive: false,
  overlayActive: false,
  groupScopeActive: false,
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

  it("inserts nodes only on an editable canvas outside a focused Group", () => {
    const state = (groupScopeActive: boolean) =>
      canvasInteractionState({ ...EDITABLE, groupScopeActive });
    expect(state(false).insertsNodes).toBe(true);
    expect(state(true).insertsNodes).toBe(false);
    expect(state(true).nodesDraggable).toBe(true);
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
