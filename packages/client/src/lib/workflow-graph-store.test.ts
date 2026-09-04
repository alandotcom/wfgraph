import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createStore as createJotaiStore } from "jotai";
import { createStore } from "jotai";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  isGroupNode,
  orderGroupParentsFirst,
} from "@wfgraph/shared/graph/node-group";
import {
  addNodeAtom,
  applyNodeLayoutAtom,
  canvasEditingLockedAtom,
  canUndoAtom,
  clearNodeStatusesAtom,
  clearWorkflowAtom,
  connectNodesAtom,
  copySelectionAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
  deleteSelectedItemsAtom,
  displayEdgesAtom,
  displayNodesAtom,
  duplicateSelectionAtom,
  edgesAtom,
  endWorkflowEditorLifetimeAtom,
  executionOverlayGraphAtom,
  exitWorkflowComparisonAtom,
  groupSelectionAtom,
  hasCopiedSelectionAtom,
  hydrateWorkflowAtom,
  installRemoteWorkflowAtom,
  installRestoredWorkflowAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  onEdgesChangeAtom,
  onNodesChangeAtom,
  pasteCopiedSelectionAtom,
  selectedNodeAtom,
  recordObservedRemoteDraftRevisionAtom,
  remoteDraftChangeAtom,
  setGroupEnabledAtom,
  setNodeStatusesAtom,
  snapshotHistoryAtom,
  undoAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import {
  autosaveDelayAtom,
  currentWorkflowDraftRevisionAtom,
  currentWorkflowIdAtom,
  hasUnsavedChangesAtom,
  isSavingAtom,
  successfulSaveGenerationAtom,
  recordLoadedDraftRevisionAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import {
  activeAgentTurnIdAtom,
  workflowGraphUpdateAtom,
  workflowWorkspaceViewAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  COMPARISON_NODE_ANNOTATION,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { savedWorkflow } from "./workflow-save-test-support";
import { PASTE_OFFSET } from "#src/lib/copy-selection";
import { formatTemplateToken } from "@wfgraph/shared/graph/node-references";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import {
  beginWorkflowComparisonRequestAtom,
  installWorkflowComparisonAtom,
} from "#src/lib/workflow-comparison-store";
import {
  beginPublicationReviewAtom,
  installPublicationReviewAtom,
} from "#src/lib/workflow-publication-review-store";

type Store = ReturnType<typeof createJotaiStore>;

const updateMock = vi.fn(() => Promise.resolve(savedWorkflow("workflow_1")));

/**
 * A store with a real workflow id, so graph mutations actually reach the save
 * queue. Running these without one would hide the defect the suite exists for:
 * a mutation that changes the graph and never persists it.
 */
function createGraphStore(nodes: WorkflowNode[], edges: WorkflowEdge[] = []) {
  const store = createStore();
  store.set(workflowApiAtom, { update: updateMock as never });
  store.set(autosaveDelayAtom, 0);
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(loadWorkflowGraphAtom, { nodes, edges });
  return store;
}

function lifecycleNode(id: string): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: id, type: "lifecycle" },
  };
}

function actionNode(id: string, x = 0): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x, y: 0 },
    data: { label: id, type: "action" },
  };
}

function groupNode(id: string, entryId: string, exitId: string): WorkflowNode {
  return {
    id,
    type: "group",
    position: { x: 0, y: 0 },
    data: {
      label: "Group",
      type: "group",
      config: { entryNodeIds: [entryId], exitNodeIds: [exitId] },
    },
  };
}

function multiExitGroupNode(id: string): WorkflowNode {
  return {
    id,
    type: "group",
    position: { x: 0, y: 0 },
    data: {
      label: "Group",
      type: "group",
      config: { entryNodeIds: ["a", "b"], exitNodeIds: ["a", "b"] },
    },
  };
}

function groupedChild(id: string, groupId: string): WorkflowNode {
  return {
    ...actionNode(id),
    parentId: groupId,
    extent: "parent",
    draggable: false,
    connectable: false,
  };
}

function edge(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target };
}

const comparisonPayload: WorkflowComparisonPayload = {
  baseVersion: null,
  proposedVersion: 1,
  baseGraph: createSerializedWorkflowGraph({
    nodes: [actionNode("historical")],
    edges: [],
  }),
  draftGraph: createSerializedWorkflowGraph({
    nodes: [actionNode("draft")],
    edges: [],
  }),
  hasChanges: true,
  nodeChanges: [{ nodeId: "historical", kind: "removed", fields: [] }],
  edgeChanges: [],
};

function openComparison(
  store: Store,
  payload: WorkflowComparisonPayload = comparisonPayload
) {
  const epoch = store.set(beginWorkflowComparisonRequestAtom, "workflow_1");
  store.set(installWorkflowComparisonAtom, {
    workflowId: "workflow_1",
    epoch,
    payload,
  });
}

/** A lookup step, which is what a Group is allowed to hold. */
function groupableLookup(id: string, x: number): WorkflowNode {
  return {
    ...actionNode(id, x),
    selected: true,
    data: {
      label: id,
      type: "action",
      config: { actionType: "fountain/get-user" },
    },
  };
}

/**
 * No action here needs a catalog entry: an action the catalog does not list
 * declares no side effect, which is what lets these lookups group.
 */
const emptyCatalog: ExtensionCatalog = {
  events: [],
  actions: [],
  integrations: [],
};

/** Let a zero-delay debounce timer fire. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function standardGraph(): [WorkflowNode[], WorkflowEdge[]] {
  return [
    [lifecycleNode("t"), actionNode("a"), actionNode("b")],
    [edge("e1", "t", "a")],
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * What React Flow does when the Delete key removes node "a".
 *
 * Mirrors `deleteElements` in @xyflow/react 12.10: `onBeforeDelete` runs while
 * the graph is still whole, then edges are removed, then nodes — three separate
 * calls into the store for one user action. The canvas wires the first of those
 * to `snapshotHistoryAtom`.
 */
function deleteNodeViaReactFlow(store: Store) {
  store.set(snapshotHistoryAtom);
  store.set(onEdgesChangeAtom, [{ type: "remove", id: "e1" }]);
  store.set(onNodesChangeAtom, [{ type: "remove", id: "a" }]);
}

/**
 * Every way the graph can change has to be both undoable and persisted,
 * decided in one place rather than per call site -- a mutation like creating
 * an edge can otherwise end up saved but not undoable.
 */
describe("graph mutations are undoable and persisted", () => {
  const mutations: Array<[string, (store: Store) => void]> = [
    ["addNode", (store) => store.set(addNodeAtom, actionNode("new"))],
    [
      "connectNodes",
      (store) => store.set(connectNodesAtom, edge("e9", "a", "b")),
    ],
    [
      "applyNodeLayout",
      (store) => store.set(applyNodeLayoutAtom, [actionNode("a", 700)]),
    ],
    ["deleteNode", (store) => store.set(deleteNodeAtom, "a")],
    ["deleteEdge", (store) => store.set(deleteEdgeAtom, "e1")],
    ["clearWorkflow", (store) => store.set(clearWorkflowAtom)],
    [
      "updateNodeData",
      (store) =>
        store.set(updateNodeDataAtom, {
          id: "a",
          data: { label: "Renamed action" },
        }),
    ],
    ["node deleted with the Delete key", deleteNodeViaReactFlow],
    [
      "edge deleted with the Delete key",
      (store) => {
        store.set(snapshotHistoryAtom);
        store.set(onEdgesChangeAtom, [{ type: "remove", id: "e1" }]);
      },
    ],
    [
      "node dragged",
      (store) => {
        store.set(onNodesChangeAtom, [
          {
            type: "position",
            id: "a",
            dragging: true,
            position: { x: 5, y: 5 },
          },
        ]);
        store.set(onNodesChangeAtom, [
          {
            type: "position",
            id: "a",
            dragging: false,
            position: { x: 9, y: 9 },
          },
        ]);
      },
    ],
    [
      "selection deleted",
      (store) => {
        store.set(onNodesChangeAtom, [
          { type: "select", id: "a", selected: true },
        ]);
        store.set(deleteSelectedItemsAtom);
      },
    ],
    [
      "copied nodes pasted",
      (store) => {
        store.set(onNodesChangeAtom, [
          { type: "select", id: "a", selected: true },
        ]);
        store.set(copySelectionAtom);
        store.set(pasteCopiedSelectionAtom);
      },
    ],
    [
      "selection duplicated",
      (store) => {
        store.set(onNodesChangeAtom, [
          { type: "select", id: "a", selected: true },
        ]);
        store.set(duplicateSelectionAtom);
      },
    ],
  ];

  for (const [name, mutate] of mutations) {
    it(`records an undo step and saves: ${name}`, async () => {
      const store = createGraphStore(...standardGraph());
      expect(store.get(canUndoAtom)).toBe(false);

      mutate(store);
      await tick();

      expect(store.get(canUndoAtom)).toBe(true);
      expect(updateMock).toHaveBeenCalled();
      expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    });
  }
});

describe("graph history", () => {
  it("undoes a connection", () => {
    const store = createGraphStore(...standardGraph());

    store.set(connectNodesAtom, edge("e9", "a", "b"));
    expect(store.get(edgesAtom)).toHaveLength(2);

    store.set(undoAtom);
    expect(store.get(edgesAtom).map((e) => e.id)).toEqual(["e1"]);
  });

  it("undoes a deleted node and its edges in one step", () => {
    const store = createGraphStore(...standardGraph());

    deleteNodeViaReactFlow(store);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["t", "b"]);
    expect(store.get(edgesAtom)).toEqual([]);

    // One undo, not two. Snapshotting inside both change handlers recorded a
    // step per pass, so undoing once brought the node back without its edge.
    store.set(undoAtom);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
      "t",
      "a",
      "b",
    ]);
    expect(store.get(edgesAtom).map((e) => e.id)).toEqual(["e1"]);
  });

  it("undoes a drag back to where it started, not to mid-drag", () => {
    const store = createGraphStore(...standardGraph());

    for (const x of [3, 6, 9]) {
      store.set(onNodesChangeAtom, [
        { type: "position", id: "a", dragging: true, position: { x, y: 0 } },
      ]);
    }
    store.set(onNodesChangeAtom, [
      { type: "position", id: "a", dragging: false, position: { x: 9, y: 0 } },
    ]);

    store.set(undoAtom);
    const nodeA = store.get(nodesAtom).find((node) => node.id === "a");
    expect(nodeA?.position.x).toBe(0);
  });

  it("undoes an auto-layout pass", () => {
    const store = createGraphStore([actionNode("a", 0), actionNode("b", 10)]);

    store.set(applyNodeLayoutAtom, [
      actionNode("a", 500),
      actionNode("b", 900),
    ]);
    expect(store.get(nodesAtom).map((node) => node.position.x)).toEqual([
      500, 900,
    ]);

    store.set(undoAtom);
    expect(store.get(nodesAtom).map((node) => node.position.x)).toEqual([
      0, 10,
    ]);
  });

  it("cannot undo across a workflow load", () => {
    const store = createGraphStore(...standardGraph());
    store.set(addNodeAtom, actionNode("new"));
    expect(store.get(canUndoAtom)).toBe(true);

    // Switching workflows. Undo must not reach back into the previous graph.
    store.set(loadWorkflowGraphAtom, { nodes: [actionNode("z")], edges: [] });
    expect(store.get(canUndoAtom)).toBe(false);

    store.set(undoAtom);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["z"]);
  });

  it("drops the previous workflow's issues when a graph is loaded", () => {
    const store = createGraphStore(...standardGraph());
    store.set(workflowIssuesAtom, [
      {
        kind: "missing_required_field",
        severity: "blocking",
        nodeId: "a",
        nodeLabel: "a",
        fieldKey: "channel",
        fieldLabel: "Channel",
        message: 'Node "a" is missing required field "Channel"',
      },
    ]);

    // The collector is debounced, so nothing else clears these for ~300ms and
    // the chip would count them against a graph holding no node "a".
    store.set(loadWorkflowGraphAtom, { nodes: [actionNode("z")], edges: [] });
    expect(store.get(workflowIssuesAtom)).toEqual([]);
  });

  it("hands a clean load the empty list it already held", () => {
    const store = createGraphStore(...standardGraph());
    const before = store.get(workflowIssuesAtom);

    // jotai compares the written value, so reusing the constant leaves
    // `workflowIssuesByNodeIdAtom` and the canvas paint below it untouched on
    // the frame a new graph mounts.
    store.set(loadWorkflowGraphAtom, { nodes: [actionNode("z")], edges: [] });
    expect(store.get(workflowIssuesAtom)).toBe(before);
  });

  it("records nothing when a delete removes nothing", () => {
    const store = createGraphStore([lifecycleNode("t")], []);

    // The Lifecycle Node cannot be deleted, so this is a no-op and must not
    // consume an undo step or fire a save.
    store.set(onNodesChangeAtom, [{ type: "select", id: "t", selected: true }]);
    store.set(deleteSelectedItemsAtom);
    store.set(clearWorkflowAtom);
    store.set(deleteNodeAtom, "t");
    store.set(deleteEdgeAtom, "missing");

    expect(store.get(canUndoAtom)).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("multi-exit Group outlet", () => {
  function groupedLookup(id: string): WorkflowNode {
    return groupedChild(id, "g");
  }

  it("connects the visible outlet from every lookup exit", () => {
    const store = createGraphStore([
      multiExitGroupNode("g"),
      groupedLookup("a"),
      groupedLookup("b"),
      actionNode("next"),
    ]);

    store.set(connectNodesAtom, edge("new-a", "g", "next"));

    expect(
      store
        .get(edgesAtom)
        .map((item) => `${item.source}->${item.target}`)
        .sort()
    ).toEqual(["a->next", "b->next"]);
  });

  it("deletes every stored edge represented by the collapsed outlet", () => {
    const store = createGraphStore(
      [
        multiExitGroupNode("g"),
        groupedLookup("a"),
        groupedLookup("b"),
        actionNode("next"),
      ],
      [edge("out-a", "a", "next"), edge("out-b", "b", "next")]
    );

    expect(store.get(displayEdgesAtom)).toHaveLength(1);
    store.set(deleteEdgeAtom, "out-a");

    expect(store.get(edgesAtom)).toEqual([]);
  });
});

describe("clearWorkflowAtom", () => {
  it("keeps the Lifecycle Node", () => {
    const store = createGraphStore(...standardGraph());

    store.set(clearWorkflowAtom);

    // A graph with no Lifecycle Node is one the server always rejects, so
    // clearing has to stop short of removing it.
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["t"]);
    expect(store.get(edgesAtom)).toEqual([]);
  });
});

describe("hydrateWorkflowAtom", () => {
  it("returns a different workflow to Draft", () => {
    const store = createGraphStore(...standardGraph());
    store.set(workflowWorkspaceViewAtom, "changes");

    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_2"));

    expect(store.get(workflowWorkspaceViewAtom)).toBe("draft");
  });

  it("clears the watched run so the previous workflow's overlay cannot repaint", () => {
    const store = createStore();
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_previous");
    expect(store.get(selectedExecutionIdAtom)).toBe("exec_previous");

    store.set(hydrateWorkflowAtom, savedWorkflow("workflow_2"));

    expect(store.get(selectedExecutionIdAtom)).toBeNull();
  });

  it("drops the previous workflow's node statuses, not just its overlay", () => {
    const store = createGraphStore(...standardGraph());
    store.set(setNodeStatusesAtom, [{ nodeId: "a", status: "running" }]);
    expect(
      store.get(displayNodesAtom).find((node) => node.id === "a")?.data.status
    ).toBe("running");

    // The freshly hydrated workflow happens to reuse node id "a"; its status
    // must read idle, not the previous workflow's "running". Hydrate leaves
    // the status map empty, so displayNodesAtom's fast path hands back the
    // node exactly as loaded rather than stamping an explicit "idle" on it --
    // `??` mirrors the node components' own `!status || status === "idle"`
    // check, which treats the two identically.
    store.set(
      hydrateWorkflowAtom,
      savedWorkflow("workflow_2", { nodes: [actionNode("a")], edges: [] })
    );

    expect(
      store.get(displayNodesAtom).find((node) => node.id === "a")?.data
        .status ?? "idle"
    ).toBe("idle");
  });

  it("keeps the open run when the same workflow is hydrated again", () => {
    const store = createGraphStore(...standardGraph());
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(selectedExecutionIdAtom, "exec_1");
    store.set(executionOverlayGraphAtom, {
      nodes: [lifecycleNode("v1_lifecycle")],
      edges: [],
    });
    store.set(setNodeStatusesAtom, [
      { nodeId: "v1_lifecycle", status: "running" },
    ]);

    store.set(
      hydrateWorkflowAtom,
      savedWorkflow("workflow_1", {
        nodes: [actionNode("draft_a")],
        edges: [],
      })
    );

    expect(store.get(selectedExecutionIdAtom)).toBe("exec_1");
    expect(
      store.get(executionOverlayGraphAtom)?.nodes.map((node) => node.id)
    ).toEqual(["v1_lifecycle"]);
    expect(
      store.get(displayNodesAtom).find((node) => node.id === "v1_lifecycle")
        ?.data.status
    ).toBe("running");
  });

  // A failed save keeps the dirty flag raised, and selecting a run or leaving
  // Runs re-runs the route loader. Without the guard that pairing replaces the
  // edit with the server's older graph and clears the failure notice, so the
  // work is gone with nothing on screen saying so.
  it("keeps a graph the server has not stored when the same workflow reloads", () => {
    const store = createGraphStore(...standardGraph());
    store.set(hasUnsavedChangesAtom, true);

    store.set(
      hydrateWorkflowAtom,
      savedWorkflow("workflow_1", { nodes: [actionNode("stale")], edges: [] })
    );

    expect(store.get(nodesAtom).map((node) => node.id)).not.toEqual(["stale"]);
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
  });

  it("keeps the edges of a write still in flight", () => {
    const store = createGraphStore(
      [lifecycleNode("a"), actionNode("b")],
      [{ id: "e1", source: "a", target: "b" }]
    );
    store.set(hasUnsavedChangesAtom, false);
    store.set(isSavingAtom, true);

    store.set(
      hydrateWorkflowAtom,
      savedWorkflow("workflow_1", {
        nodes: [lifecycleNode("a"), actionNode("b")],
        edges: [],
      })
    );

    expect(store.get(edgesAtom).map((saved) => saved.id)).toEqual(["e1"]);
  });

  it("discards a hydration snapshot that started before a successful save", () => {
    const store = createGraphStore(...standardGraph());
    const requestGeneration =
      store.get(successfulSaveGenerationAtom).get("workflow_1") ?? 0;

    // The loader captured the older server snapshot before the save landed.
    // Model the save settling before the loader completes, including the state
    // changes that make the existing dirty and in-flight guards pass.
    store.set(successfulSaveGenerationAtom, new Map([["workflow_1", 1]]));
    store.set(isSavingAtom, false);
    store.set(hasUnsavedChangesAtom, false);

    store.set(hydrateWorkflowAtom, {
      ...savedWorkflow("workflow_1", {
        nodes: [actionNode("stale")],
        edges: [],
      }),
      saveGeneration: requestGeneration,
    });

    expect(store.get(nodesAtom).map((node) => node.id)).not.toEqual(["stale"]);
  });

  it("takes the server's graph once the client and the server agree", () => {
    const store = createGraphStore(...standardGraph());
    store.set(hasUnsavedChangesAtom, false);
    store.set(isSavingAtom, false);

    store.set(
      hydrateWorkflowAtom,
      savedWorkflow("workflow_1", { nodes: [actionNode("fresh")], edges: [] })
    );

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["fresh"]);
  });
});

describe("installRemoteWorkflowAtom", () => {
  it("installs a newer persisted graph without saving it again", () => {
    const store = createGraphStore(...standardGraph());
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: "workflow_1",
      draftRevision: 1,
    });

    const installed = store.set(installRemoteWorkflowAtom, {
      ...savedWorkflow("workflow_1", {
        nodes: [actionNode("remote")],
        edges: [],
      }),
      draftRevision: 2,
    });

    expect(installed).toBe(true);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["remote"]);
    expect(store.get(currentWorkflowDraftRevisionAtom)).toBe(2);
    expect(store.get(workflowGraphUpdateAtom)).toEqual({
      workflowId: "workflow_1",
      revision: 1,
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("preserves local work when a newer persisted graph arrives", () => {
    const store = createGraphStore(...standardGraph());
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: "workflow_1",
      draftRevision: 1,
    });
    store.set(hasUnsavedChangesAtom, true);
    store.set(recordObservedRemoteDraftRevisionAtom, {
      workflowId: "workflow_1",
      draftRevision: 2,
    });

    const installed = store.set(installRemoteWorkflowAtom, {
      ...savedWorkflow("workflow_1", {
        nodes: [actionNode("remote")],
        edges: [],
      }),
      draftRevision: 2,
    });

    expect(installed).toBe(false);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
      "t",
      "a",
      "b",
    ]);
    expect(store.get(currentWorkflowDraftRevisionAtom)).toBe(1);
    expect(store.get(remoteDraftChangeAtom)?.draftRevision).toBe(2);
  });

  it("preserves a built-in agent turn when an external edit arrives", () => {
    const store = createGraphStore(...standardGraph());
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: "workflow_1",
      draftRevision: 1,
    });
    store.set(activeAgentTurnIdAtom, Symbol("agent-turn"));

    const installed = store.set(installRemoteWorkflowAtom, {
      ...savedWorkflow("workflow_1", {
        nodes: [actionNode("remote")],
        edges: [],
      }),
      draftRevision: 2,
    });

    expect(installed).toBe(false);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
      "t",
      "a",
      "b",
    ]);
  });

  it("preserves a pending publication review when an external edit arrives", () => {
    const store = createGraphStore(...standardGraph());
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: "workflow_1",
      draftRevision: 1,
    });
    store.set(beginPublicationReviewAtom, "workflow_1");

    const installed = store.set(installRemoteWorkflowAtom, {
      ...savedWorkflow("workflow_1", {
        nodes: [actionNode("remote")],
        edges: [],
      }),
      draftRevision: 2,
    });

    expect(installed).toBe(false);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
      "t",
      "a",
      "b",
    ]);
  });

  it("preserves an active publication review when an external edit arrives", () => {
    const store = createGraphStore(...standardGraph());
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: "workflow_1",
      draftRevision: 1,
    });
    const epoch = store.set(beginPublicationReviewAtom, "workflow_1");
    store.set(installPublicationReviewAtom, {
      workflowId: "workflow_1",
      epoch: epoch ?? 0,
      pending: false,
      graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      expectedDraftRevision: 1,
      expectedPublishedVersionId: null,
      review: { proposedVersion: 1, nodeChanges: [], edgeChanges: [] },
    });

    const installed = store.set(installRemoteWorkflowAtom, {
      ...savedWorkflow("workflow_1", {
        nodes: [actionNode("remote")],
        edges: [],
      }),
      draftRevision: 2,
    });

    expect(installed).toBe(false);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
      "t",
      "a",
      "b",
    ]);
  });

  it("preserves a node drag until its position settles", () => {
    const store = createGraphStore(...standardGraph());
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: "workflow_1",
      draftRevision: 1,
    });
    store.set(onNodesChangeAtom, [
      {
        type: "position",
        id: "a",
        position: { x: 120, y: 80 },
        dragging: true,
      },
    ]);

    const installed = store.set(installRemoteWorkflowAtom, {
      ...savedWorkflow("workflow_1", {
        nodes: [actionNode("remote")],
        edges: [],
      }),
      draftRevision: 2,
    });

    expect(installed).toBe(false);
    expect(
      store.get(nodesAtom).find((node) => node.id === "a")?.position
    ).toEqual({ x: 120, y: 80 });
  });

  it("does not hydrate over a drag in the open workflow", () => {
    const store = createGraphStore(...standardGraph());
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: "workflow_1",
      draftRevision: 1,
    });
    store.set(onNodesChangeAtom, [
      {
        type: "position",
        id: "a",
        position: { x: 120, y: 80 },
        dragging: true,
      },
    ]);

    store.set(hydrateWorkflowAtom, {
      ...savedWorkflow("workflow_1", {
        nodes: [actionNode("remote")],
        edges: [],
      }),
      draftRevision: 2,
    });

    expect(
      store.get(nodesAtom).find((node) => node.id === "a")?.position
    ).toEqual({ x: 120, y: 80 });
    expect(store.get(currentWorkflowDraftRevisionAtom)).toBe(1);
  });

  it("allows remote updates after navigation interrupts a drag", () => {
    const store = createGraphStore(...standardGraph());
    store.set(onNodesChangeAtom, [
      {
        type: "position",
        id: "a",
        position: { x: 120, y: 80 },
        dragging: true,
      },
    ]);
    store.set(
      hydrateWorkflowAtom,
      savedWorkflow("workflow_2", {
        nodes: [actionNode("opened")],
        edges: [],
      })
    );

    const installed = store.set(installRemoteWorkflowAtom, {
      ...savedWorkflow("workflow_2", {
        nodes: [actionNode("remote")],
        edges: [],
      }),
      draftRevision: 2,
    });

    expect(installed).toBe(true);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["remote"]);
  });

  it("allows remote updates after reopening a workflow interrupted during a drag", () => {
    const store = createGraphStore(...standardGraph());
    store.set(onNodesChangeAtom, [
      {
        type: "position",
        id: "a",
        position: { x: 120, y: 80 },
        dragging: true,
      },
    ]);

    store.set(endWorkflowEditorLifetimeAtom);
    store.set(
      hydrateWorkflowAtom,
      savedWorkflow("workflow_1", {
        nodes: [actionNode("reopened")],
        edges: [],
      })
    );

    const installed = store.set(installRemoteWorkflowAtom, {
      ...savedWorkflow("workflow_1", {
        nodes: [actionNode("remote")],
        edges: [],
      }),
      draftRevision: 2,
    });

    expect(installed).toBe(true);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["remote"]);
  });
});

describe("comparison exit and restore installation", () => {
  it("restores draft selection only when the comparison selection exists in the draft", () => {
    const store = createGraphStore([
      { ...actionNode("draft"), selected: true },
      { ...actionNode("other"), selected: true },
    ]);
    openComparison(store);
    store.set(selectedNodeAtom, "historical");

    expect(store.set(exitWorkflowComparisonAtom)).toBe(true);
    expect(store.get(selectedNodeAtom)).toBeNull();
    expect(store.get(nodesAtom).every((node) => !node.selected)).toBe(true);
    expect(store.get(canUndoAtom)).toBe(false);
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);

    openComparison(store);
    store.set(selectedNodeAtom, "draft");
    store.set(exitWorkflowComparisonAtom);

    expect(store.get(selectedNodeAtom)).toBe("draft");
    expect(
      store
        .get(nodesAtom)
        .filter((node) => node.selected)
        .map((node) => node.id)
    ).toEqual(["draft"]);
  });

  it("does not install a late restored workflow after the editor navigates", () => {
    const store = createGraphStore([actionNode("a")]);
    store.set(currentWorkflowIdAtom, "workflow_b");
    store.set(loadWorkflowGraphAtom, { nodes: [actionNode("b")], edges: [] });

    expect(
      store.set(installRestoredWorkflowAtom, {
        expectedWorkflowId: "workflow_1",
        workflow: savedWorkflow("workflow_1", {
          nodes: [actionNode("restored_a")],
          edges: [],
        }),
      })
    ).toBe(false);
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["b"]);
  });
});

describe("displayNodesAtom memoization", () => {
  // React.memo on ActionNode and LifecycleNode bails out on a shallow prop
  // comparison, which only works if a node that has not changed keeps its old
  // object identity. Rebuilding every node into a fresh object on every
  // recompute -- the common case, because most recomputes carry no status and
  // no inactive Canceled branch to paint -- would re-render every node on every
  // drag frame and every keystroke.
  it("returns the draft's own node objects when there is nothing to merge", () => {
    const store = createGraphStore(...standardGraph());
    const draftNodes = store.get(nodesAtom);

    const displayed = store.get(displayNodesAtom);

    expect(displayed).toHaveLength(draftNodes.length);
    for (const [index, node] of draftNodes.entries()) {
      expect(displayed[index]).toBe(node);
    }
  });

  it("orders a loaded Group graph so display can reuse the store array", () => {
    const rest = lifecycleNode("t");
    const frame = groupNode("g", "a", "a");
    const child = groupedChild("a", "g");
    const store = createGraphStore([child, rest, frame]);

    const draft = store.get(nodesAtom);
    expect(draft.map((node) => node.id)).toEqual(["t", "g", "a"]);
    expect(store.get(displayNodesAtom)).toBe(draft);
  });

  it("orders a hydrated Group workflow the same way", () => {
    const store = createGraphStore(...standardGraph());
    store.set(
      hydrateWorkflowAtom,
      savedWorkflow("workflow_grouped", {
        nodes: [
          groupedChild("a", "g"),
          lifecycleNode("t"),
          groupNode("g", "a", "a"),
        ],
        edges: [],
      })
    );

    const draft = store.get(nodesAtom);
    expect(draft.map((node) => node.id)).toEqual(["t", "g", "a"]);
    expect(store.get(displayNodesAtom)).toBe(draft);
  });

  it("orders a pinned Group overlay so display can reuse that array", () => {
    const store = createGraphStore(...standardGraph());
    store.set(workflowWorkspaceViewAtom, "runs");
    const rest = lifecycleNode("pinned_t");
    const frame = groupNode("pinned_g", "pinned_a", "pinned_a");
    const child = groupedChild("pinned_a", "pinned_g");
    store.set(executionOverlayGraphAtom, {
      nodes: [child, rest, frame],
      edges: [],
    });

    const overlay = store.get(executionOverlayGraphAtom)?.nodes;
    expect(overlay?.map((node) => node.id)).toEqual([
      "pinned_t",
      "pinned_g",
      "pinned_a",
    ]);
    expect(store.get(displayNodesAtom)).toBe(overlay);
  });

  it("paints the inspector's selected node onto a pinned overlay", () => {
    const store = createGraphStore(...standardGraph());
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(executionOverlayGraphAtom, {
      nodes: [lifecycleNode("pinned_t"), actionNode("pinned_a")],
      edges: [],
    });

    store.set(selectedNodeAtom, "pinned_a");

    expect(
      store.get(displayNodesAtom).find((node) => node.id === "pinned_a")
        ?.selected
    ).toBe(true);
    expect(
      store.get(displayNodesAtom).find((node) => node.id === "pinned_t")
        ?.selected
    ).not.toBe(true);
  });

  it("lets only the active workspace view choose the displayed graph", () => {
    const store = createGraphStore([actionNode("draft")]);
    store.set(workflowWorkspaceViewAtom, "changes");
    openComparison(store);
    store.set(executionOverlayGraphAtom, {
      nodes: [actionNode("run")],
      edges: [],
    });

    expect(store.get(displayNodesAtom).map((node) => node.id)).toEqual([
      "draft",
      "historical",
    ]);

    store.set(workflowWorkspaceViewAtom, "runs");
    expect(store.get(displayNodesAtom).map((node) => node.id)).toEqual(["run"]);

    store.set(workflowWorkspaceViewAtom, "draft");
    expect(store.get(displayNodesAtom).map((node) => node.id)).toEqual([
      "draft",
    ]);
  });
});

/**
 * A painted node is the stored node with run status, the disabled-frame flag,
 * and the issue summary laid over it. Everything else the stored node carries
 * has to survive that, including the keys the paint itself is named after and
 * the symbol the comparison view stamps on.
 */
describe("displayNodesAtom keeps what the stored node already carries", () => {
  it("leaves a disabled step disabled while a run is painted", () => {
    const disabled: WorkflowNode = {
      ...actionNode("a"),
      data: { label: "a", type: "action", enabled: false },
    };
    const store = createGraphStore([lifecycleNode("t"), disabled]);

    store.set(setNodeStatusesAtom, [{ nodeId: "a", status: "running" }]);

    const painted = store.get(displayNodesAtom).find((node) => node.id === "a");
    expect(painted?.data.enabled).toBe(false);
    expect(painted?.data.status).toBe("running");
  });

  it("keeps the comparison marker on a frame it repaints as disabled", () => {
    const store = createGraphStore(...standardGraph());
    store.set(workflowWorkspaceViewAtom, "changes");
    const child: WorkflowNode = {
      ...groupedChild("a", "g"),
      data: { label: "a", type: "action", enabled: false },
    };
    openComparison(store, {
      ...comparisonPayload,
      baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      draftGraph: createSerializedWorkflowGraph({
        nodes: [groupNode("g", "a", "a"), child],
        edges: [],
      }),
      nodeChanges: [{ nodeId: "g", kind: "modified", fields: [] }],
    });

    // Every member of the frame is disabled, so the frame is painted disabled,
    // and that repaint is where the marker used to be dropped.
    const frame = store.get(displayNodesAtom).find((node) => node.id === "g");
    expect(frame?.data.enabled).toBe(false);
    expect(frame?.data[COMPARISON_NODE_ANNOTATION]).toEqual({
      kind: "modified",
    });
  });
});

describe("canvasEditingLockedAtom", () => {
  it("locks Runs and Changes even before their display graph loads", () => {
    const store = createGraphStore(...standardGraph());

    store.set(workflowWorkspaceViewAtom, "runs");
    expect(store.get(canvasEditingLockedAtom)).toBe(true);

    store.set(workflowWorkspaceViewAtom, "changes");
    expect(store.get(canvasEditingLockedAtom)).toBe(true);

    store.set(workflowWorkspaceViewAtom, "draft");
    expect(store.get(canvasEditingLockedAtom)).toBe(false);
  });
});

/**
 * Run status is a display-time concern, merged onto whichever graph
 * `displayNodesAtom` is showing -- the draft or a pinned run overlay -- the
 * same way `inactiveBranchAtom` is already merged in. It must never
 * live on the graph's own node data, because that is what forces a second
 * full copy of the graph to carry it.
 */
describe("run status", () => {
  it("merges onto the draft without writing into the draft's own node data", () => {
    const store = createGraphStore(...standardGraph());

    store.set(setNodeStatusesAtom, [{ nodeId: "a", status: "running" }]);

    expect(
      store.get(displayNodesAtom).find((node) => node.id === "a")?.data.status
    ).toBe("running");
    // The draft itself -- what gets persisted -- never sees the status.
    expect(
      store.get(nodesAtom).find((node) => node.id === "a")?.data.status
    ).toBeUndefined();
  });

  it("defaults every node with no reported status to idle", () => {
    const store = createGraphStore(...standardGraph());

    store.set(setNodeStatusesAtom, [{ nodeId: "a", status: "running" }]);

    expect(
      store.get(displayNodesAtom).find((node) => node.id === "t")?.data.status
    ).toBe("idle");
  });

  it("merges onto a pinned run overlay by the same path as the draft", () => {
    const store = createGraphStore(...standardGraph());
    // The overlay reaches the canvas only while Runs is active, so a case
    // about what the canvas paints has to say the tab is open.
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(executionOverlayGraphAtom, {
      nodes: [lifecycleNode("pinned_t"), actionNode("pinned_a")],
      edges: [],
    });

    store.set(setNodeStatusesAtom, [{ nodeId: "pinned_a", status: "success" }]);

    expect(
      store.get(displayNodesAtom).find((node) => node.id === "pinned_a")?.data
        .status
    ).toBe("success");
    // Statuses set while the overlay is up must not have landed on the draft,
    // reachable again once the overlay is cleared.
    store.set(executionOverlayGraphAtom, null);
    expect(
      store.get(nodesAtom).find((node) => node.id === "a")?.data.status
    ).toBeUndefined();
  });

  it("clears every status and drops the overlay together", () => {
    const store = createGraphStore(...standardGraph());
    // Without the tab open the overlay reads null anyway, and the assertion
    // below would hold whether or not the clear did its job.
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(executionOverlayGraphAtom, {
      nodes: [lifecycleNode("t")],
      edges: [],
    });
    store.set(setNodeStatusesAtom, [{ nodeId: "t", status: "error" }]);

    store.set(clearNodeStatusesAtom);

    expect(store.get(executionOverlayGraphAtom)).toBeNull();
    // An empty status map trips displayNodesAtom's fast path, so the draft's
    // node "a" comes back exactly as stored rather than carrying an explicit
    // "idle" -- equivalent to idle in every way that matters, because the node
    // components treat a missing status the same as "idle".
    expect(
      store.get(displayNodesAtom).find((node) => node.id === "a")?.data
        .status ?? "idle"
    ).toBe("idle");
  });
});

describe("updateNodeDataAtom refuses a status write", () => {
  // Run status lives in its own map and is merged at display time, so writing
  // one into a node's own data would resurrect the duplicate-state bug #50
  // removed. `NodeDataUpdate` omits the field, and this asserts the compiler
  // really enforces that: if the type ever widens back, `@ts-expect-error`
  // has nothing to suppress and type-check fails on this line.
  it("is a compile error, not a comment", () => {
    const store = createGraphStore(...standardGraph());

    store.set(updateNodeDataAtom, {
      id: "a",
      // @ts-expect-error -- status is omitted from NodeDataUpdate on purpose
      data: { status: "success" },
    });

    // The write is rejected by the type system, not at runtime; jotai still
    // applies whatever it was handed, so this only pins the compile-time rule.
    expect(store.get(nodesAtom).some((node) => node.id === "a")).toBe(true);
  });
});

describe("updateNodeDataAtom enabled flag", () => {
  it("drops enabled: true so a re-enabled step matches the default", () => {
    const store = createGraphStore(...standardGraph());

    store.set(updateNodeDataAtom, { id: "a", data: { enabled: false } });
    expect(
      store.get(nodesAtom).find((node) => node.id === "a")?.data.enabled
    ).toBe(false);

    store.set(updateNodeDataAtom, { id: "a", data: { enabled: true } });
    expect(
      store.get(nodesAtom).find((node) => node.id === "a")?.data.enabled
    ).toBeUndefined();
  });
});

describe("copy and paste", () => {
  it("pastes a clone beside the original and selects it", () => {
    const store = createGraphStore(
      [lifecycleNode("t"), { ...actionNode("a", 100), selected: true }],
      []
    );

    store.set(copySelectionAtom);
    store.set(pasteCopiedSelectionAtom);

    const nodes = store.get(nodesAtom);
    const pasted = nodes.find((node) => node.id !== "t" && node.id !== "a");
    expect(nodes).toHaveLength(3);
    expect(pasted?.position).toEqual({
      x: 100 + PASTE_OFFSET,
      y: PASTE_OFFSET,
    });
    expect(pasted?.selected).toBe(true);
    expect(nodes.find((node) => node.id === "a")?.selected).toBe(false);
  });

  it("keeps edges that ran between the copied nodes", () => {
    const store = createGraphStore(
      [
        lifecycleNode("t"),
        { ...actionNode("a"), selected: true },
        { ...actionNode("b", 80), selected: true },
      ],
      [edge("e-a-b", "a", "b")]
    );

    store.set(copySelectionAtom);
    store.set(pasteCopiedSelectionAtom);

    const originalIds = new Set(["t", "a", "b"]);
    const pasted = store
      .get(nodesAtom)
      .filter((node) => !originalIds.has(node.id));
    expect(pasted).toHaveLength(2);

    const pastedIds = new Set(pasted.map((node) => node.id));
    const newEdges = store
      .get(edgesAtom)
      .filter(
        (item) => pastedIds.has(item.source) && pastedIds.has(item.target)
      );
    expect(newEdges).toHaveLength(1);
    expect(store.get(edgesAtom)).toHaveLength(2);
  });

  it("rewrites template tokens that named a copied node", () => {
    const token = formatTemplateToken({
      nodeId: "a",
      nodeLabel: "Fetch",
      fieldPath: "email",
    });
    const store = createGraphStore(
      [
        lifecycleNode("t"),
        { ...actionNode("a"), selected: true },
        {
          ...actionNode("b", 80),
          selected: true,
          data: {
            label: "b",
            type: "action",
            config: { body: token },
          },
        },
      ],
      []
    );

    store.set(copySelectionAtom);
    store.set(pasteCopiedSelectionAtom);

    const pastedB = store
      .get(nodesAtom)
      .find(
        (node) =>
          node.id !== "b" &&
          node.data.type === "action" &&
          typeof node.data.config?.body === "string"
      );
    const pastedA = store
      .get(nodesAtom)
      .find((node) => node.id !== "a" && node.data.label === "a");
    expect(pastedA).toBeDefined();
    expect(pastedB?.data.config?.body).toBe(
      formatTemplateToken({
        nodeId: pastedA?.id ?? "",
        nodeLabel: "Fetch",
        fieldPath: "email",
      })
    );
  });

  it("does not copy the Lifecycle Node", () => {
    const store = createGraphStore(
      [{ ...lifecycleNode("t"), selected: true }],
      []
    );

    expect(store.set(copySelectionAtom)).toBe(false);
    expect(store.get(hasCopiedSelectionAtom)).toBe(false);
    expect(store.set(pasteCopiedSelectionAtom)).toBe(false);
    expect(store.get(nodesAtom)).toHaveLength(1);
  });

  it("leaves the clipboard intact across a workflow load", () => {
    const store = createGraphStore(
      [lifecycleNode("t"), { ...actionNode("a"), selected: true }],
      []
    );
    store.set(copySelectionAtom);

    store.set(loadWorkflowGraphAtom, {
      nodes: [lifecycleNode("t2")],
      edges: [],
    });

    expect(store.get(hasCopiedSelectionAtom)).toBe(true);
    store.set(pasteCopiedSelectionAtom);
    expect(store.get(nodesAtom).map((node) => node.data.label)).toEqual([
      "t2",
      "a",
    ]);
  });

  it("refuses to paste onto a pinned run overlay", () => {
    const store = createGraphStore(
      [lifecycleNode("t"), { ...actionNode("a"), selected: true }],
      []
    );
    store.set(copySelectionAtom);
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(executionOverlayGraphAtom, {
      nodes: [lifecycleNode("pinned")],
      edges: [],
    });

    expect(store.set(pasteCopiedSelectionAtom)).toBe(false);
    expect(store.get(nodesAtom)).toHaveLength(2);
  });

  it("copies an unselected node when given its id", () => {
    const store = createGraphStore(
      [
        lifecycleNode("t"),
        { ...actionNode("a"), selected: false },
        { ...actionNode("b", 80), selected: true },
      ],
      []
    );

    expect(store.set(copySelectionAtom, "a")).toBe(true);
    store.set(pasteCopiedSelectionAtom);

    const labels = store.get(nodesAtom).map((node) => node.data.label);
    expect(labels.filter((label) => label === "a")).toHaveLength(2);
    expect(labels.filter((label) => label === "b")).toHaveLength(1);
  });

  it("duplicates without writing the clipboard", () => {
    const store = createGraphStore(
      [
        lifecycleNode("t"),
        { ...actionNode("a"), selected: true },
        { ...actionNode("b", 80), selected: false },
      ],
      []
    );

    store.set(copySelectionAtom);
    store.set(onNodesChangeAtom, [
      { type: "select", id: "a", selected: false },
      { type: "select", id: "b", selected: true },
    ]);
    store.set(duplicateSelectionAtom);

    const afterDuplicate = store.get(nodesAtom).map((node) => node.data.label);
    expect(afterDuplicate.filter((label) => label === "b")).toHaveLength(2);
    expect(afterDuplicate.filter((label) => label === "a")).toHaveLength(1);

    store.set(pasteCopiedSelectionAtom);
    const afterPaste = store.get(nodesAtom).map((node) => node.data.label);
    expect(afterPaste.filter((label) => label === "a")).toHaveLength(2);
    expect(afterPaste.filter((label) => label === "b")).toHaveLength(2);
  });
});

describe("updateNodeDataAtom rewrites template labels", () => {
  it("updates tokens in nested objects and arrays", () => {
    const token = formatTemplateToken({
      nodeId: "a",
      nodeLabel: "Fetch",
      fieldPath: "email",
    });
    const store = createGraphStore(
      [
        lifecycleNode("t"),
        {
          ...actionNode("a"),
          data: { label: "Fetch", type: "action" },
        },
        {
          ...actionNode("b", 80),
          data: {
            label: "b",
            type: "action",
            config: { list: [token], nested: { to: token } },
          },
        },
      ],
      []
    );

    store.set(updateNodeDataAtom, { id: "a", data: { label: "Renamed" } });

    const expected = formatTemplateToken({
      nodeId: "a",
      nodeLabel: "Renamed",
      fieldPath: "email",
    });
    expect(
      store.get(nodesAtom).find((node) => node.id === "b")?.data.config
    ).toEqual({
      list: [expected],
      nested: { to: expected },
    });
  });

  it("rewrites tokens even when the config still holds undefined optional keys", () => {
    const token = formatTemplateToken({
      nodeId: "a",
      nodeLabel: "Fetch",
      fieldPath: "email",
    });
    const store = createGraphStore(
      [
        lifecycleNode("t"),
        {
          ...actionNode("a"),
          data: { label: "Fetch", type: "action" },
        },
        {
          ...actionNode("b", 80),
          data: {
            label: "b",
            type: "action",
            config: { integrationId: undefined, body: token },
          },
        },
      ],
      []
    );

    store.set(updateNodeDataAtom, { id: "a", data: { label: "Renamed" } });

    expect(
      store.get(nodesAtom).find((node) => node.id === "b")?.data.config
    ).toStrictEqual({
      integrationId: undefined,
      body: formatTemplateToken({
        nodeId: "a",
        nodeLabel: "Renamed",
        fieldPath: "email",
      }),
    });
  });
});

describe("groupSelectionAtom", () => {
  it("groups an explicit id set after the live selection has collapsed", () => {
    const lookup = (id: string, x: number): WorkflowNode => ({
      ...actionNode(id, x),
      selected: false,
      data: {
        label: id,
        type: "action",
        config: { actionType: "fountain/get-user" },
      },
    });
    const store = createGraphStore(
      [
        lifecycleNode("life"),
        lookup("a", 0),
        lookup("b", 200),
        {
          ...actionNode("c", 100),
          selected: true,
          data: {
            label: "c",
            type: "action",
            config: { actionType: BUILT_IN_ACTION_IDS.condition },
          },
        },
      ],
      [
        edge("e-start-a", "life", "a"),
        edge("e-start-b", "life", "b"),
        edge("e-a", "a", "c"),
        edge("e-b", "b", "c"),
      ]
    );

    expect(
      store.set(groupSelectionAtom, {
        catalog: emptyCatalog,
        selectedIds: new Set(["a", "b", "c"]),
      })
    ).toBe(true);
    expect(store.get(nodesAtom).some((node) => isGroupNode(node))).toBe(true);
  });

  it("groups the live selection when no ids are passed", () => {
    const selectedLookup = (id: string, x: number): WorkflowNode => ({
      ...actionNode(id, x),
      selected: true,
      data: {
        label: id,
        type: "action",
        config: { actionType: "fountain/get-user" },
      },
    });
    const store = createGraphStore(
      [
        lifecycleNode("life"),
        selectedLookup("a", 0),
        selectedLookup("b", 200),
        {
          ...actionNode("c", 100),
          selected: true,
          data: {
            label: "c",
            type: "action",
            config: { actionType: BUILT_IN_ACTION_IDS.condition },
          },
        },
      ],
      [
        edge("e-start-a", "life", "a"),
        edge("e-start-b", "life", "b"),
        edge("e-a", "a", "c"),
        edge("e-b", "b", "c"),
      ]
    );

    expect(store.set(groupSelectionAtom, { catalog: emptyCatalog })).toBe(true);
    const frame = store.get(nodesAtom).find((node) => isGroupNode(node));
    expect(frame?.data.config).toMatchObject({
      entryNodeIds: ["a", "b"],
      exitNodeIds: ["c"],
      outletHandle: "true",
    });
  });

  // A pasted frame lands after the members already on the canvas, which costs
  // `displayNodesAtom` its identity fast path on every render from then on.
  it("keeps the order when a frame is pasted beside one already there", () => {
    const store = createGraphStore(
      [
        lifecycleNode("life"),
        groupableLookup("a", 0),
        groupableLookup("b", 200),
        {
          ...actionNode("c", 100),
          selected: true,
          data: {
            label: "c",
            type: "action",
            config: { actionType: BUILT_IN_ACTION_IDS.condition },
          },
        },
      ],
      [
        edge("e-start-a", "life", "a"),
        edge("e-start-b", "life", "b"),
        edge("e-a", "a", "c"),
        edge("e-b", "b", "c"),
      ]
    );
    store.set(groupSelectionAtom, {
      catalog: emptyCatalog,
      selectedIds: new Set(["a", "b", "c"]),
    });
    store.set(copySelectionAtom);
    store.set(pasteCopiedSelectionAtom);

    const nodes = store.get(nodesAtom);
    expect(orderGroupParentsFirst(nodes)).toBe(nodes);
  });

  /**
   * React Flow deletes a frame by expanding it into its children, and it asks
   * for no edge it was told it cannot delete. A frame's interior edges are
   * painted `deletable: false`, and a collapsed inlet edge never reaches React
   * Flow at all, so both survive a delete the node pass alone. The next save
   * then refuses the graph, because those edges name nodes that are gone.
   */
  it("drops the edges a removed frame leaves behind", () => {
    const store = createGraphStore(
      [
        lifecycleNode("life"),
        groupableLookup("a", 0),
        groupableLookup("b", 200),
        {
          ...actionNode("c", 100),
          selected: true,
          data: {
            label: "c",
            type: "action",
            config: { actionType: BUILT_IN_ACTION_IDS.condition },
          },
        },
      ],
      [
        edge("e-start-a", "life", "a"),
        edge("e-start-b", "life", "b"),
        edge("e-a", "a", "c"),
        edge("e-b", "b", "c"),
      ]
    );
    store.set(groupSelectionAtom, {
      catalog: emptyCatalog,
      selectedIds: new Set(["a", "b", "c"]),
    });
    const frameId = store.get(nodesAtom).find((node) => isGroupNode(node))?.id;
    expect(frameId).toBeDefined();

    store.set(snapshotHistoryAtom);
    // The one painted edge React Flow can see and delete.
    store.set(onEdgesChangeAtom, [{ type: "remove", id: "e-start-a" }]);
    store.set(onNodesChangeAtom, [
      { type: "remove", id: frameId ?? "" },
      { type: "remove", id: "a" },
      { type: "remove", id: "b" },
      { type: "remove", id: "c" },
    ]);

    const liveIds = new Set(store.get(nodesAtom).map((node) => node.id));
    expect(
      store
        .get(edgesAtom)
        .filter(
          (item) => !liveIds.has(item.source) || !liveIds.has(item.target)
        )
    ).toEqual([]);
  });
});

describe("what the canvas paints for a step that cannot run", () => {
  function disabled(node: WorkflowNode): WorkflowNode {
    return { ...node, data: { ...node.data, enabled: false } };
  }

  it("mutes the edge leaving a disabled step, and not the one into it", () => {
    const store = createGraphStore(
      [lifecycleNode("t"), disabled(actionNode("a")), actionNode("b")],
      [edge("e-in", "t", "a"), edge("e-out", "a", "b")]
    );

    const edges = store.get(displayEdgesAtom);
    expect(edges.find((item) => item.id === "e-in")?.data?.inactive).toBe(
      undefined
    );
    expect(edges.find((item) => item.id === "e-out")?.data?.inactive).toBe(
      true
    );
  });

  it("mutes the step below a disabled one, and leaves that one to its own face", () => {
    const store = createGraphStore(
      [lifecycleNode("t"), disabled(actionNode("a")), actionNode("b")],
      [edge("e-in", "t", "a"), edge("e-out", "a", "b")]
    );

    const nodes = store.get(displayNodesAtom);
    expect(nodes.find((node) => node.id === "a")?.style).toBeUndefined();
    expect(nodes.find((node) => node.id === "b")?.style).toMatchObject({
      opacity: 0.5,
    });
  });
});

describe("what the canvas paints for a node the validator flagged", () => {
  const brokenA = {
    kind: "missing_required_field" as const,
    severity: "blocking" as const,
    nodeId: "a",
    nodeLabel: "a",
    fieldKey: "channel",
    fieldLabel: "Channel",
    message: 'Node "a" is missing required field "Channel"',
  };

  it("wears the badge on the flagged node and nothing on the rest", () => {
    const store = createGraphStore([
      lifecycleNode("t"),
      actionNode("a"),
      actionNode("b"),
    ]);
    store.set(workflowIssuesAtom, [brokenA]);

    const nodes = store.get(displayNodesAtom);
    expect(nodes.find((node) => node.id === "a")?.data.issues).toEqual({
      severity: "blocking",
      messages: [brokenA.message],
    });
    expect(nodes.find((node) => node.id === "b")?.data.issues).toBeUndefined();
  });

  /**
   * The canvas memoises every card on `data` identity, so a clean graph has to
   * come back by reference or the badge pass would re-render the whole canvas on
   * every read of this atom.
   */
  it("hands a clean graph straight back, untouched", () => {
    const store = createGraphStore([lifecycleNode("t"), actionNode("a")]);

    const first = store.get(displayNodesAtom);
    const second = store.get(displayNodesAtom);
    expect(first[1]).toBe(second[1]);
    expect(first[1]?.data.issues).toBeUndefined();
  });

  /**
   * The regression this guards is a drag: one node moves, the atom recomputes,
   * and every *other* flagged node must come back as the object it already was.
   * Reading the atom twice with nothing changed in between does not test this --
   * jotai answers that from its own cache without running the body.
   */
  it("repaints only the node that moved, leaving other flagged cards alone", () => {
    const store = createGraphStore([
      lifecycleNode("t"),
      actionNode("a"),
      actionNode("b"),
    ]);
    store.set(workflowIssuesAtom, [brokenA, { ...brokenA, nodeId: "b" }]);

    const before = store.get(displayNodesAtom);
    const flaggedBefore = before.find((node) => node.id === "b");

    store.set(onNodesChangeAtom, [
      { type: "position", id: "a", dragging: true, position: { x: 40, y: 40 } },
    ]);

    const after = store.get(displayNodesAtom);
    expect(after.find((node) => node.id === "b")).toBe(flaggedBefore);
    expect(after.find((node) => node.id === "a")).not.toBe(
      before.find((node) => node.id === "a")
    );
  });

  it("leaves a pinned run's graph unbadged", () => {
    const store = createGraphStore([lifecycleNode("t"), actionNode("a")]);
    store.set(workflowIssuesAtom, [brokenA]);
    // The overlay reaches the canvas only while Runs is active.
    store.set(workflowWorkspaceViewAtom, "runs");
    store.set(executionOverlayGraphAtom, {
      nodes: [lifecycleNode("t"), actionNode("a")],
      edges: [],
    });

    const nodes = store.get(displayNodesAtom);
    expect(nodes.find((node) => node.id === "a")?.data.issues).toBeUndefined();
  });
});

describe("setGroupEnabledAtom", () => {
  function groupedGraph(): Store {
    const lookup = (id: string, x: number): WorkflowNode => ({
      ...actionNode(id, x),
      selected: true,
      data: {
        label: id,
        type: "action",
        config: { actionType: "fountain/get-user" },
      },
    });
    const store = createGraphStore(
      [
        lifecycleNode("life"),
        lookup("a", 0),
        lookup("b", 200),
        {
          ...actionNode("c", 100),
          selected: true,
          data: {
            label: "c",
            type: "action",
            config: { actionType: BUILT_IN_ACTION_IDS.condition },
          },
        },
        actionNode("after", 100),
      ],
      [
        edge("e-start-a", "life", "a"),
        edge("e-start-b", "life", "b"),
        edge("e-a", "a", "c"),
        edge("e-b", "b", "c"),
        { ...edge("e-after", "c", "after"), sourceHandle: "true" },
      ]
    );
    store.set(groupSelectionAtom, { catalog: emptyCatalog });
    return store;
  }

  it("writes the flag onto every member in one undo step", () => {
    const store = groupedGraph();
    const frameId = store.get(nodesAtom).find((node) => isGroupNode(node))?.id;

    expect(
      store.set(setGroupEnabledAtom, {
        groupId: frameId ?? "",
        enabled: false,
      })
    ).toBe(true);

    const members = store
      .get(nodesAtom)
      .filter((node) => node.parentId === frameId);
    expect(members).toHaveLength(3);
    expect(members.every((node) => node.data.enabled === false)).toBe(true);

    store.set(undoAtom);
    expect(
      store
        .get(nodesAtom)
        .filter((node) => node.parentId === frameId)
        .every((node) => node.data.enabled === undefined)
    ).toBe(true);
  });

  it("clears the flag when the frame is switched back on", () => {
    const store = groupedGraph();
    const frameId = store.get(nodesAtom).find((node) => isGroupNode(node))?.id;

    store.set(setGroupEnabledAtom, { groupId: frameId ?? "", enabled: false });
    store.set(setGroupEnabledAtom, { groupId: frameId ?? "", enabled: true });

    expect(
      store
        .get(nodesAtom)
        .filter((node) => node.parentId === frameId)
        .every((node) => node.data.enabled === undefined)
    ).toBe(true);
  });

  it("greys the frame and everything the run can no longer reach", () => {
    const store = groupedGraph();
    const frameId = store.get(nodesAtom).find((node) => isGroupNode(node))?.id;
    store.set(setGroupEnabledAtom, { groupId: frameId ?? "", enabled: false });

    const frame = store
      .get(displayNodesAtom)
      .find((node) => node.id === frameId);
    expect(frame?.data.enabled).toBe(false);

    const after = store
      .get(displayNodesAtom)
      .find((node) => node.id === "after");
    expect(after?.style).toMatchObject({ opacity: 0.5 });

    const outlet = store
      .get(displayEdgesAtom)
      .find((item) => item.target === "after");
    expect(outlet?.data?.inactive).toBe(true);
  });
});
