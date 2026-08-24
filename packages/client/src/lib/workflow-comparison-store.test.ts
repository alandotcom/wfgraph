import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import type { WorkflowNode as PersistedWorkflowNode } from "@wfgraph/shared/graph/types";
import {
  comparisonDisplayGraphAtom,
  comparisonSessionAtom,
  beginWorkflowComparisonRequestAtom,
  clearWorkflowComparisonAtom,
  installWorkflowComparisonAtom,
  isComparisonPendingAtom,
  isComparisonActiveAtom,
  moveComparisonNodesAtom,
  resetComparisonLayoutAtom,
  selectComparisonHistoryVersionAtom,
  setComparisonSubviewAtom,
  setWorkflowComparisonVisibleAtom,
  settleWorkflowComparisonRequestAtom,
} from "#src/lib/workflow-comparison-store";
import {
  canvasEditingLockedAtom,
  canUndoAtom,
  displayEdgesAtom,
  displayNodesAtom,
  executionOverlayGraphAtom,
  hydrateWorkflowAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  onNodesChangeAtom,
  selectedNodeAtom,
  setNodeStatusesAtom,
} from "#src/lib/workflow-graph-store";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  hasUnsavedChangesAtom,
  isWorkflowOwnerAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { propertiesPanelActiveTabAtom } from "#src/lib/workflow-ui-store";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import { savedWorkflow } from "./workflow-save-test-support";

function node(id: string, x: number): PersistedWorkflowNode {
  return {
    id,
    type: "action",
    position: { x, y: 0 },
    data: { label: id, type: "action" },
  };
}

const comparison: WorkflowComparisonPayload = {
  baseVersion: null,
  proposedVersion: 1,
  baseGraph: createSerializedWorkflowGraph({
    nodes: [node("shared", 0), node("deleted", 100)],
    edges: [{ id: "removed-edge", source: "shared", target: "deleted" }],
  }),
  draftGraph: createSerializedWorkflowGraph({
    nodes: [node("shared", 20)],
    edges: [],
  }),
  hasChanges: true,
  nodeChanges: [{ nodeId: "deleted", kind: "removed", fields: [] }],
  edgeChanges: [{ edgeId: "removed-edge", kind: "removed" }],
};
const historicalBase = {
  id: "v1",
  version: 1,
  publishedAt: "2026-08-23T00:00:00.000Z",
  isCurrent: false,
};

function installComparison(
  store: ReturnType<typeof createStore>,
  input: {
    workflowId: string;
    payload: WorkflowComparisonPayload;
    preserveSession?: boolean;
    selectedHistoryVersionId?: string | null;
  }
) {
  const epoch = store.set(beginWorkflowComparisonRequestAtom, input.workflowId);
  store.set(installWorkflowComparisonAtom, { ...input, epoch });
  store.set(settleWorkflowComparisonRequestAtom, {
    workflowId: input.workflowId,
    epoch,
  });
  return epoch;
}

describe("comparison session store", () => {
  it("scopes an installed payload by workflow and preserves panel selection state", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");

    installComparison(store, {
      workflowId: "workflow_1",
      payload: comparison,
    });
    store.set(selectedNodeAtom, "deleted");
    store.set(selectComparisonHistoryVersionAtom, {
      workflowId: "workflow_1",
      versionId: "version_1",
    });

    expect(store.get(isComparisonActiveAtom)).toBe(true);
    expect(store.get(comparisonSessionAtom)).toMatchObject({
      selectedHistoryVersionId: "version_1",
    });
    store.set(currentWorkflowIdAtom, "workflow_2");
    expect(store.get(comparisonSessionAtom)).toBeNull();
  });

  it("keeps a hidden comparison session while returning the canvas to the draft", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(loadWorkflowGraphAtom, {
      nodes: [
        {
          id: "draft",
          position: { x: 0, y: 0 },
          data: { label: "Draft", type: "action" },
        },
      ],
      edges: [],
    });
    installComparison(store, {
      workflowId: "workflow_1",
      payload: comparison,
    });

    store.set(setWorkflowComparisonVisibleAtom, {
      workflowId: "workflow_1",
      visible: false,
    });

    expect(store.get(comparisonSessionAtom)).not.toBeNull();
    expect(store.get(isComparisonActiveAtom)).toBe(false);
    expect(store.get(displayNodesAtom).map((item) => item.id)).toEqual([
      "draft",
    ]);

    store.set(setWorkflowComparisonVisibleAtom, {
      workflowId: "workflow_1",
      visible: true,
    });
    expect(store.get(isComparisonActiveAtom)).toBe(true);
    expect(store.get(displayNodesAtom).map((item) => item.id)).toContain(
      "deleted"
    );
  });

  it("preserves review state and temporary layout when a refreshed payload replaces it", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    installComparison(store, {
      workflowId: "workflow_1",
      payload: comparison,
    });
    store.set(selectedNodeAtom, "deleted");
    store.set(setComparisonSubviewAtom, {
      workflowId: "workflow_1",
      subview: "history",
    });
    store.set(moveComparisonNodesAtom, {
      workflowId: "workflow_1",
      changes: [
        { type: "position", id: "deleted", position: { x: 222, y: 44 } },
      ],
    });

    installComparison(store, {
      workflowId: "workflow_1",
      payload: { ...comparison, proposedVersion: 2 },
      preserveSession: true,
      selectedHistoryVersionId: "version_1",
    });

    expect(store.get(comparisonSessionAtom)).toMatchObject({
      selectedHistoryVersionId: "version_1",
      subview: "history",
      positionOverrides: { deleted: { x: 222, y: 44 } },
      payload: { proposedVersion: 2 },
    });
  });

  it("moves only deleted nodes, updates their edge graph, and resets locally", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    installComparison(store, {
      workflowId: "workflow_1",
      payload: comparison,
    });
    const beforeMove = store.get(comparisonDisplayGraphAtom);

    store.set(moveComparisonNodesAtom, {
      workflowId: "workflow_1",
      changes: [
        { type: "position", id: "shared", position: { x: 400, y: 0 } },
        {
          type: "position",
          id: "deleted",
          dragging: false,
          position: { x: 300, y: 40 },
        },
      ],
    });

    expect(
      store
        .get(comparisonDisplayGraphAtom)
        ?.nodes.find((item) => item.id === "deleted")?.position
    ).toEqual({ x: 300, y: 40 });
    expect(
      store
        .get(comparisonDisplayGraphAtom)
        ?.nodes.find((item) => item.id === "shared")?.position
    ).toEqual({ x: 20, y: 0 });
    expect(store.get(displayEdgesAtom)[0]).toMatchObject({
      source: "shared",
      target: "deleted",
    });
    const afterMove = store.get(comparisonDisplayGraphAtom);
    expect(afterMove?.nodes.find((item) => item.id === "shared")).toBe(
      beforeMove?.nodes.find((item) => item.id === "shared")
    );
    expect(afterMove?.edges[0]).toBe(beforeMove?.edges[0]);

    store.set(resetComparisonLayoutAtom, "workflow_1");
    expect(
      store
        .get(comparisonDisplayGraphAtom)
        ?.nodes.find((item) => item.id === "deleted")?.position
    ).toEqual({ x: 100, y: 0 });
  });

  it("clears a comparison when the same workflow is hydrated again", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    installComparison(store, {
      workflowId: "workflow_1",
      payload: comparison,
    });
    expect(store.get(isComparisonActiveAtom)).toBe(true);

    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_1"));

    expect(store.get(comparisonSessionAtom)).toBeNull();
    expect(store.get(isComparisonActiveAtom)).toBe(false);
  });

  it("rejects a response from before comparison clear or hydration", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    const clearedEpoch = store.set(
      beginWorkflowComparisonRequestAtom,
      "workflow_1"
    );
    store.set(clearWorkflowComparisonAtom, "workflow_1");

    expect(
      store.set(installWorkflowComparisonAtom, {
        workflowId: "workflow_1",
        epoch: clearedEpoch,
        payload: comparison,
      })
    ).toBe(false);
    expect(store.get(comparisonSessionAtom)).toBeNull();
    expect(store.get(isComparisonPendingAtom)).toBe(false);

    const hydratedEpoch = store.set(
      beginWorkflowComparisonRequestAtom,
      "workflow_1"
    );
    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_1"));

    expect(
      store.set(installWorkflowComparisonAtom, {
        workflowId: "workflow_1",
        epoch: hydratedEpoch,
        payload: comparison,
      })
    ).toBe(false);
    expect(store.get(comparisonSessionAtom)).toBeNull();
  });

  it("keeps a newer request pending when an older request settles", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    const firstEpoch = store.set(
      beginWorkflowComparisonRequestAtom,
      "workflow_1"
    );
    const secondEpoch = store.set(
      beginWorkflowComparisonRequestAtom,
      "workflow_1"
    );

    expect(
      store.set(settleWorkflowComparisonRequestAtom, {
        workflowId: "workflow_1",
        epoch: firstEpoch,
      })
    ).toBe(false);
    expect(store.get(isComparisonPendingAtom)).toBe(true);
    expect(
      store.set(installWorkflowComparisonAtom, {
        workflowId: "workflow_1",
        epoch: firstEpoch,
        payload: comparison,
      })
    ).toBe(false);

    store.set(settleWorkflowComparisonRequestAtom, {
      workflowId: "workflow_1",
      epoch: secondEpoch,
    });
    expect(store.get(isComparisonPendingAtom)).toBe(false);
  });

  it("retains a selected historical base when its refreshed payload arrives", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    installComparison(store, {
      workflowId: "workflow_1",
      payload: { ...comparison, baseVersion: historicalBase },
      selectedHistoryVersionId: "v1",
    });

    installComparison(store, {
      workflowId: "workflow_1",
      payload: {
        ...comparison,
        proposedVersion: 3,
        baseVersion: historicalBase,
      },
      preserveSession: true,
    });

    expect(store.get(comparisonSessionAtom)?.selectedHistoryVersionId).toBe(
      "v1"
    );
  });

  it("leaves draft save, history, and dirty state unchanged after comparison movement", () => {
    const update = vi.fn(() => Promise.resolve());
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(autosaveDelayAtom, 0);
    store.set(workflowApiAtom, { update: update as never });
    installComparison(store, {
      workflowId: "workflow_1",
      payload: comparison,
    });

    store.set(moveComparisonNodesAtom, {
      workflowId: "workflow_1",
      changes: [
        {
          type: "position",
          id: "deleted",
          dragging: true,
          position: { x: 500, y: 0 },
        },
      ],
    });

    expect(store.get(canUndoAtom)).toBe(false);
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(store.get(displayNodesAtom).map((item) => item.id)).toEqual([
      "shared",
      "deleted",
    ]);
  });

  it("keeps comparison ahead of the draft, below a visible run, and free of run or validation paint", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(isWorkflowOwnerAtom, true);
    store.set(loadWorkflowGraphAtom, {
      nodes: [
        {
          id: "draft",
          type: "action",
          position: { x: 900, y: 0 },
          data: { label: "Draft", type: "action" },
        },
      ],
      edges: [],
    });
    store.set(setNodeStatusesAtom, [{ nodeId: "shared", status: "running" }]);
    store.set(workflowIssuesAtom, [
      {
        kind: "missing_required_field",
        severity: "blocking",
        nodeId: "shared",
        nodeLabel: "shared",
        fieldKey: "subject",
        fieldLabel: "Subject",
        message: "Subject is required",
      },
    ]);
    installComparison(store, {
      workflowId: "workflow_1",
      payload: comparison,
    });

    expect(store.get(canvasEditingLockedAtom)).toBe(true);
    expect(store.get(displayNodesAtom).map((item) => item.id)).toEqual([
      "shared",
      "deleted",
    ]);
    expect(store.get(displayNodesAtom)[0]?.data.status).toBeUndefined();
    expect(store.get(displayNodesAtom)[0]?.data.issues).toBeUndefined();

    store.set(propertiesPanelActiveTabAtom, "runs");
    store.set(executionOverlayGraphAtom, {
      nodes: [
        {
          id: "run-node",
          type: "action",
          position: { x: 0, y: 0 },
          data: { label: "Run node", type: "action" },
        },
      ],
      edges: [],
    });
    store.set(setNodeStatusesAtom, [{ nodeId: "run-node", status: "running" }]);
    expect(store.get(displayNodesAtom).map((item) => item.id)).toEqual([
      "run-node",
    ]);
    expect(store.get(displayNodesAtom)[0]?.data.status).toBe("running");

    store.set(propertiesPanelActiveTabAtom, "properties");
    expect(store.get(displayNodesAtom).map((item) => item.id)).toEqual([
      "shared",
      "deleted",
    ]);
  });

  it("refuses normal draft changes while a comparison is active", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(loadWorkflowGraphAtom, {
      nodes: [
        {
          id: "draft",
          type: "action",
          position: { x: 10, y: 0 },
          data: { label: "Draft", type: "action" },
        },
      ],
      edges: [],
    });
    installComparison(store, {
      workflowId: "workflow_1",
      payload: comparison,
    });

    store.set(onNodesChangeAtom, [
      {
        type: "position",
        id: "draft",
        dragging: false,
        position: { x: 400, y: 0 },
      },
    ]);

    expect(store.get(nodesAtom)[0]?.position).toEqual({ x: 10, y: 0 });
    expect(store.get(canUndoAtom)).toBe(false);
  });

  it("locks draft writes while a comparison request is pending without replacing the draft canvas", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(loadWorkflowGraphAtom, {
      nodes: [
        {
          id: "draft",
          type: "action",
          position: { x: 10, y: 0 },
          data: { label: "Draft", type: "action" },
        },
      ],
      edges: [],
    });
    store.set(beginWorkflowComparisonRequestAtom, "workflow_1");

    expect(store.get(isComparisonPendingAtom)).toBe(true);
    expect(store.get(isComparisonActiveAtom)).toBe(false);
    expect(
      store.get(displayNodesAtom).map((displayNode) => displayNode.id)
    ).toEqual(["draft"]);
    expect(store.get(canvasEditingLockedAtom)).toBe(true);
  });
});
