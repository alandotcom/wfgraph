import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  beginWorkflowComparisonRequestAtom,
  comparisonSessionAtom,
  installWorkflowComparisonAtom,
} from "#src/lib/workflow-comparison-store";
import {
  executionOverlayGraphAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  isWorkflowOwnerAtom,
} from "#src/lib/workflow-save-store";
import {
  selectedExecutionIdAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import {
  enterChangesWorkspaceAtom,
  enterDraftWorkspaceAtom,
  enterRunsWorkspaceAtom,
} from "#src/lib/workflow-workspace-navigation";

const comparison = {
  baseVersion: null,
  proposedVersion: 1,
  baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
  draftGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
  hasChanges: false,
  nodeChanges: [],
  edgeChanges: [],
};

function storeWithComparison() {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(isWorkflowOwnerAtom, true);
  store.set(workflowWorkspaceViewAtom, "changes");
  const epoch = store.set(beginWorkflowComparisonRequestAtom, "workflow_1");
  store.set(installWorkflowComparisonAtom, {
    workflowId: "workflow_1",
    epoch,
    payload: comparison,
  });
  return store;
}

describe("workspace transitions", () => {
  it("enters Draft by clearing run and comparison presentation state", () => {
    const store = storeWithComparison();
    store.set(selectedNodeAtom, "historical");
    store.set(selectedExecutionIdAtom, "run_1");
    store.set(executionOverlayGraphAtom, { nodes: [], edges: [] });

    store.set(enterDraftWorkspaceAtom);

    expect(store.get(workflowWorkspaceViewAtom)).toBe("draft");
    expect(store.get(selectedExecutionIdAtom)).toBeNull();
    expect(store.get(executionOverlayGraphAtom)).toBeNull();
    expect(store.get(comparisonSessionAtom)).toBeNull();
    expect(store.get(selectedNodeAtom)).toBeNull();
  });

  it("enters Runs by clearing comparison state", () => {
    const store = storeWithComparison();

    store.set(enterRunsWorkspaceAtom);

    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
    expect(store.get(comparisonSessionAtom)).toBeNull();
  });

  it("enters Changes by clearing the selected run and its graph", () => {
    const store = createStore();
    store.set(isWorkflowOwnerAtom, true);
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(selectedExecutionIdAtom, "run_1");
    store.set(executionOverlayGraphAtom, { nodes: [], edges: [] });

    store.set(enterChangesWorkspaceAtom);

    expect(store.get(workflowWorkspaceViewAtom)).toBe("changes");
    expect(store.get(selectedExecutionIdAtom)).toBeNull();
    expect(store.get(executionOverlayGraphAtom)).toBeNull();
  });
});
