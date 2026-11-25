import { fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider, useAtomValue } from "jotai";
import type { Store } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { useWorkflowNodeInspection } from "#src/components/workflow/use-workflow-node-inspection";
import {
  canvasEdgesAtom,
  displayNodesAtom,
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";

const DRAFT_NODES: WorkflowNode[] = [
  {
    id: "draft_a",
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: "Draft A", type: "action" },
  },
];

const DRAFT_EDGE: WorkflowEdge = {
  id: "edge_1",
  source: "draft_a",
  target: "draft_a",
};

const READ_ONLY_NODE: WorkflowNode = {
  id: "readonly_b",
  type: "action",
  position: { x: 200, y: 0 },
  data: { label: "Read-only B", type: "action" },
};

function InspectorButton({
  nodeId,
  selectionApplied,
}: {
  nodeId: string;
  selectionApplied: boolean;
}) {
  const inspect = useWorkflowNodeInspection();
  const displayNodes = useAtomValue(displayNodesAtom);

  return (
    <button onClick={() => inspect(nodeId, { selectionApplied })} type="button">
      Inspect {displayNodes.length} nodes
    </button>
  );
}

function renderInspector(
  store: Store,
  nodeId = "readonly_b",
  selectionApplied = false
) {
  return render(
    <JotaiProvider store={store}>
      <OverlayProvider>
        <InspectorButton nodeId={nodeId} selectionApplied={selectionApplied} />
      </OverlayProvider>
    </JotaiProvider>
  );
}

/** A Draft whose node and edge React Flow has both selected. */
function selectionStore() {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(loadWorkflowGraphAtom, {
    nodes: DRAFT_NODES,
    edges: [DRAFT_EDGE],
  });
  showWorkspaceRoute(store, {});
  store.set(activeSelectionAtom, { nodeIds: ["draft_a"], edgeIds: ["edge_1"] });
  return store;
}

/** The owner's selection beside the flags the active canvas paints from it. */
function selectionState(store: Store) {
  return {
    owner: store.get(activeSelectionAtom),
    painted: {
      nodeIds: store
        .get(displayNodesAtom)
        .filter((node) => node.selected)
        .map((node) => node.id),
      edgeIds: store
        .get(canvasEdgesAtom)
        .filter((edge) => edge.selected)
        .map((edge) => edge.id),
    },
  };
}

/** The read-only node is the only selection, and Draft kept its own. */
function assertReadOnlySelection(
  store: Store,
  view: { search: { view: "runs" } }
) {
  const readOnly = { nodeIds: ["readonly_b"], edgeIds: [] };
  expect(store.get(selectedNodeAtom)).toBe("readonly_b");
  expect(store.get(selectedEdgeAtom)).toBeNull();
  expect(selectionState(store)).toEqual({ owner: readOnly, painted: readOnly });

  const draft = { nodeIds: ["draft_a"], edgeIds: ["edge_1"] };
  showWorkspaceRoute(store, {});
  expect(selectionState(store)).toEqual({ owner: draft, painted: draft });
  showWorkspaceRoute(store, view.search);
  expect(selectionState(store).owner).toEqual(readOnly);
}

/**
 * Happy-dom's viewport, which `useIsMobile` answers from. It is one value per
 * test worker, and the suite runs with `isolate: false`, so a file that ran a
 * phone-width case before this one would leave the mobile Reveal in place of
 * the desktop one these cases read.
 */
function setDesktopViewport(): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width: 1440 });
}

beforeEach(setDesktopViewport);

describe("useWorkflowNodeInspection", () => {
  it("keeps the multi-selection React Flow wrote on a Draft canvas click", () => {
    const store = selectionStore();
    const view = renderInspector(store, "draft_a", true);

    fireEvent.click(view.getByRole("button", { name: /Inspect/ }));

    const both = { nodeIds: ["draft_a"], edgeIds: ["edge_1"] };
    expect(selectionState(store)).toEqual({ owner: both, painted: both });
    expect(store.get(selectedNodeAtom)).toBeNull();
  });

  it("makes the node the only Draft selection when nothing selected it", () => {
    const store = selectionStore();
    const view = renderInspector(store, "draft_a");

    fireEvent.click(view.getByRole("button", { name: /Inspect/ }));

    const only = { nodeIds: ["draft_a"], edgeIds: [] };
    expect(selectionState(store)).toEqual({ owner: only, painted: only });
    expect(store.get(selectedNodeAtom)).toBe("draft_a");
  });

  it("clears a stale edge selection when clicking a node in Runs", () => {
    const store = selectionStore();
    showWorkspaceRoute(store, { view: "runs" });
    store.set(executionOverlayGraphAtom, {
      nodes: [READ_ONLY_NODE],
      edges: [],
    });
    const view = renderInspector(store);

    fireEvent.click(view.getByRole("button", { name: /Inspect/ }));

    assertReadOnlySelection(store, { search: { view: "runs" } });
  });
});
