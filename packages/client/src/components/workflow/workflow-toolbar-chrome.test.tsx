import { render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { ToolbarActions } from "#src/components/workflow/workflow-toolbar-chrome";
import type {
  WorkflowToolbarActions,
  WorkflowToolbarState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { isGeneratingAtom } from "#src/lib/workflow-ui-store";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import { toEditorNode } from "#src/lib/workflow-graph-types";
import { toWorkflowGraphData } from "@rova/shared/graph/graph";

/**
 * `publishDisabled` used to check only isGenerating / isSaving / node
 * presence, so Publish stayed clickable while a run overlay pinned the canvas
 * to a past run and hid the real draft (#39). This exercises the wiring
 * directly against `ToolbarActions`, since `publishDisabled` is computed
 * inline rather than exported.
 */

// One real lifecycle node, so the "at least one real step" arm of
// `publishDisabled` is already satisfied and the overlay is the only thing
// left that can gate the button.
const REAL_NODES = toWorkflowGraphData(
  createSerializedWorkflowGraph({
    nodes: [
      {
        id: "lifecycle_1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: "Lifecycle", type: "lifecycle" },
      },
    ],
    edges: [],
  })
).nodes.map(toEditorNode);

function baseState(): WorkflowToolbarState {
  return {
    nodes: REAL_NODES,
    edges: [],
    isExecuting: false,
    setIsExecuting: vi.fn(),
    isGenerating: false,
    clearWorkflow: vi.fn(),
    updateNodeData: vi.fn(),
    currentWorkflowId: "workflow_1",
    workflowName: "Workflow",
    workflowMode: "live",
    setCurrentWorkflowName: vi.fn(),
    setCurrentWorkflowMode: vi.fn(),
    setWorkflowNameError: vi.fn(),
    setIsTransitioningFromHomepage: vi.fn(),
    isOwner: true,
    isSaving: false,
    hasUnsavedChanges: false,
    undo: vi.fn(),
    redo: vi.fn(),
    addNode: vi.fn(),
    canUndo: false,
    canRedo: false,
    allWorkflows: [],
    setActiveTab: vi.fn(),
    setSelectedNodeId: vi.fn(),
    userIntegrations: [],
  };
}

function baseActions(): WorkflowToolbarActions {
  return {
    handleSave: vi.fn(async () => {}),
    handleExecute: vi.fn(async () => {}),
    handleClearWorkflow: vi.fn(),
    handleDeleteWorkflow: vi.fn(),
    loadWorkflows: vi.fn(async () => {}),
    handleDuplicate: vi.fn(),
    isDuplicating: false,
    handlePublish: vi.fn(),
    isPublishing: false,
    handleSetWorkflowMode: vi.fn(async () => {}),
  };
}

function renderToolbarActions(
  lock: { overlayActive?: boolean; generating?: boolean } = {}
) {
  const store = createStore();
  if (lock.overlayActive) {
    store.set(executionOverlayGraphAtom, { nodes: [], edges: [] });
  }
  if (lock.generating) {
    store.set(isGeneratingAtom, true);
  }

  return render(
    <JotaiProvider store={store}>
      <ReactFlowProvider>
        <OverlayProvider>
          <ToolbarActions
            actions={baseActions()}
            state={baseState()}
            workflowId="workflow_1"
          />
        </OverlayProvider>
      </ReactFlowProvider>
    </JotaiProvider>
  );
}

describe("ToolbarActions publish gating", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps Publish enabled with no run overlay open", () => {
    const { getByTitle } = renderToolbarActions();
    expect(getByTitle("Publish workflow").hasAttribute("disabled")).toBe(false);
  });

  it("disables Publish while a run overlay pins the canvas to a past run", () => {
    const { getByTitle } = renderToolbarActions({ overlayActive: true });
    expect(getByTitle("Publish workflow").hasAttribute("disabled")).toBe(true);
  });

  // Publish and the canvas read one `canvasEditingLockedAtom`, so generation
  // gates both. This case would still pass if Publish kept its own copy of the
  // condition, and it fails if a later edit drops generation from the shared
  // atom while leaving the canvas reading it.
  it("disables Publish while generation is rewriting the graph", () => {
    const { getByTitle } = renderToolbarActions({ generating: true });
    expect(getByTitle("Publish workflow").hasAttribute("disabled")).toBe(true);
  });
});
