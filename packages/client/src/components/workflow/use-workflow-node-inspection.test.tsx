import { act, fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider, useAtomValue } from "jotai";
import { describe, expect, it } from "vitest";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { useWorkflowNodeInspection } from "#src/components/workflow/use-workflow-node-inspection";
import {
  beginWorkflowComparisonRequestAtom,
  installWorkflowComparisonAtom,
} from "#src/lib/workflow-comparison-store";
import {
  displayNodesAtom,
  edgesAtom,
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";

const DRAFT_NODES: WorkflowNode[] = [
  {
    id: "draft_a",
    type: "action",
    position: { x: 0, y: 0 },
    selected: true,
    data: { label: "Draft A", type: "action" },
  },
];

const DRAFT_EDGE: WorkflowEdge = {
  id: "edge_1",
  source: "draft_a",
  target: "draft_a",
  selected: true,
};

const READ_ONLY_NODE: WorkflowNode = {
  id: "readonly_b",
  type: "action",
  position: { x: 200, y: 0 },
  data: { label: "Read-only B", type: "action" },
};

function InspectorButton({ nodeId }: { nodeId: string }) {
  const inspect = useWorkflowNodeInspection();
  const displayNodes = useAtomValue(displayNodesAtom);

  return (
    <button onClick={() => inspect(nodeId)} type="button">
      Inspect {displayNodes.length} nodes
    </button>
  );
}

function renderInspector(
  store: ReturnType<typeof createStore>,
  nodeId = "readonly_b"
) {
  return render(
    <JotaiProvider store={store}>
      <OverlayProvider>
        <InspectorButton nodeId={nodeId} />
      </OverlayProvider>
    </JotaiProvider>
  );
}

function selectionStore() {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(loadWorkflowGraphAtom, {
    nodes: DRAFT_NODES,
    edges: [DRAFT_EDGE],
  });
  store.set(selectedNodeAtom, "draft_a");
  store.set(selectedEdgeAtom, "edge_1");
  return store;
}

function assertDraftSelectionUnchanged(store: ReturnType<typeof createStore>) {
  expect(store.get(selectedEdgeAtom)).toBeNull();
  expect(store.get(selectedNodeAtom)).toBe("readonly_b");
  expect(
    store
      .get(nodesAtom)
      .filter((node) => node.selected)
      .map((node) => node.id)
  ).toEqual(["draft_a"]);
  expect(
    store
      .get(edgesAtom)
      .filter((edge) => edge.selected)
      .map((edge) => edge.id)
  ).toEqual(["edge_1"]);
  expect(
    store
      .get(displayNodesAtom)
      .filter((node) => node.selected)
      .map((node) => node.id)
  ).toEqual(["readonly_b"]);
}

describe("useWorkflowNodeInspection", () => {
  it("keeps Draft selection flags under React Flow's direct-click ownership", () => {
    const store = selectionStore();
    const view = renderInspector(store, "draft_a");

    fireEvent.click(view.getByRole("button", { name: /Inspect/ }));

    expect(store.get(selectedNodeAtom)).toBe("draft_a");
    expect(store.get(selectedEdgeAtom)).toBe("edge_1");
    expect(
      store.get(edgesAtom).find((edge) => edge.id === "edge_1")?.selected
    ).toBe(true);
  });

  it("clears a stale edge selection when clicking a node in Runs", () => {
    const store = selectionStore();
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(executionOverlayGraphAtom, {
      nodes: [READ_ONLY_NODE],
      edges: [],
    });
    const view = renderInspector(store);

    fireEvent.click(view.getByRole("button", { name: /Inspect/ }));

    assertDraftSelectionUnchanged(store);
  });

  it("clears a stale edge selection when clicking a node in Changes", () => {
    const store = selectionStore();
    const comparison: WorkflowComparisonPayload = {
      baseVersion: null,
      proposedVersion: 1,
      baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [READ_ONLY_NODE],
        edges: [],
      }),
      hasChanges: true,
      nodeChanges: [{ nodeId: "readonly_b", kind: "added", fields: [] }],
      edgeChanges: [],
    };
    const epoch = store.set(beginWorkflowComparisonRequestAtom, "workflow_1");
    store.set(installWorkflowComparisonAtom, {
      workflowId: "workflow_1",
      epoch,
      payload: comparison,
    });
    store.set(workflowWorkspaceViewAtom, "changes");
    const view = renderInspector(store);

    act(() => {
      fireEvent.click(view.getByRole("button", { name: /Inspect/ }));
    });

    assertDraftSelectionUnchanged(store);
  });
});
