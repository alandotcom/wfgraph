import { render, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { WorkflowToolbar } from "#src/components/workflow/workflow-toolbar";
import {
  currentWorkflowIdAtom,
  hasUnpublishedChangesAtom,
  hasUnsavedChangesAtom,
  saveWorkflowAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

const toolbar = vi.hoisted(() => ({
  state: {
    allWorkflows: [
      {
        id: "workflow_1",
        name: "Workflow",
        publishedVersionId: "version_1",
      },
    ],
    currentWorkflowId: "workflow_1",
    hasUnsavedChanges: false,
    hasUnpublishedChanges: false,
    isOwner: true,
    workflowMode: "live" as const,
  },
}));

vi.mock("#src/components/workflows/user-menu", () => ({
  UserMenu: () => null,
}));

vi.mock("#src/components/workflow/workflow-toolbar-chrome", () => ({
  DuplicateButton: () => null,
  ToolbarActions: () => null,
  WorkflowMenuComponent: () => null,
}));

vi.mock("#src/components/workflow/workflow-toolbar-handlers", () => ({
  useWorkflowActions: () => ({}),
  useWorkflowState: () => toolbar.state,
}));

function actionNode(x: number): WorkflowNode {
  return {
    id: "node_1",
    type: "action",
    position: { x, y: 0 },
    data: {
      label: "Send",
      type: "action",
      config: { actionType: "custom/send-message" },
    },
  };
}

describe("workflow publication badge", () => {
  it("keeps Unpublished changes after a draft save that differs from published", async () => {
    const store = createStore();
    const pendingSave =
      Promise.withResolvers<ReturnType<typeof savedWorkflow>>();

    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(hasUnpublishedChangesAtom, false);
    store.set(workflowApiAtom, {
      ...store.get(workflowApiAtom),
      update: () => pendingSave.promise,
    });

    const save = store.set(
      saveWorkflowAtom,
      { nodes: [actionNode(120)], edges: [] },
      { immediate: true }
    );

    pendingSave.resolve({
      ...savedWorkflow("workflow_1"),
      publishedVersionId: "version_1",
      hasUnpublishedChanges: true,
    });
    await save;

    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(hasUnpublishedChangesAtom)).toBe(true);

    toolbar.state.hasUnsavedChanges = store.get(hasUnsavedChangesAtom);
    toolbar.state.hasUnpublishedChanges = store.get(hasUnpublishedChangesAtom);
    render(<WorkflowToolbar workflowId="workflow_1" />);

    expect(screen.getByText("Unpublished changes")).toBeTruthy();
    expect(screen.queryByText("Published")).toBeNull();
  });

  it("shows Published when the draft matches the published version", () => {
    toolbar.state.hasUnsavedChanges = false;
    toolbar.state.hasUnpublishedChanges = false;
    render(<WorkflowToolbar workflowId="workflow_1" />);

    expect(screen.getByText("Published")).toBeTruthy();
    expect(screen.queryByText("Unpublished changes")).toBeNull();
  });
});
