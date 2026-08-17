import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createStore as createJotaiStore } from "jotai";
import { createStore } from "jotai";
import {
  addNodeAtom,
  applyNodeLayoutAtom,
  canUndoAtom,
  clearNodeStatusesAtom,
  clearWorkflowAtom,
  connectNodesAtom,
  copySelectionAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
  deleteSelectedItemsAtom,
  displayNodesAtom,
  duplicateSelectionAtom,
  edgesAtom,
  executionOverlayGraphAtom,
  hasCopiedSelectionAtom,
  hydrateWorkflowAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  onEdgesChangeAtom,
  onNodesChangeAtom,
  pasteCopiedSelectionAtom,
  setNodeStatusesAtom,
  snapshotHistoryAtom,
  undoAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  hasUnsavedChangesAtom,
  isWorkflowOwnerAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import {
  propertiesPanelActiveTabAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { savedWorkflow } from "./workflow-save-test-support";
import { PASTE_OFFSET } from "#src/lib/copy-selection";
import { formatTemplateToken } from "@wfgraph/shared/graph/node-references";

type Store = ReturnType<typeof createJotaiStore>;

const updateMock = vi.fn(() => Promise.resolve(savedWorkflow("workflow_1")));

/**
 * A store with a real workflow id, so graph mutations actually reach the save
 * queue. Running these without one would hide the defect the suite exists for:
 * a mutation that changes the graph and never persists it.
 */
function createGraphStore(nodes: WorkflowNode[], edges: WorkflowEdge[] = []) {
  const store = createStore();
  store.set(workflowApiAtom, {
    create: vi.fn() as never,
    update: updateMock as never,
  });
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

function edge(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target, type: "animated" };
}

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
  it("clears the watched run so the previous workflow's overlay cannot repaint", () => {
    const store = createStore();
    store.set(isWorkflowOwnerAtom, true);
    store.set(propertiesPanelActiveTabAtom, "runs");
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
});

describe("displayNodesAtom memoization", () => {
  // React.memo on ActionNode and LifecycleNode bails out on a shallow prop
  // comparison, which only works if a node that has not changed keeps its old
  // object identity. Rebuilding every node into a fresh object on every
  // recompute -- the common case, since most recomputes carry no status and no
  // inactive Canceled branch to paint -- would re-render every node on every
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
});

/**
 * Run status is a display-time concern, merged onto whichever graph
 * `displayNodesAtom` is showing -- the draft or a pinned run overlay -- the
 * same way `inactiveCanceledBranchAtom` is already merged in. It must never
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
    // The overlay reaches the canvas only while the Runs tab is up, so a case
    // about what the canvas paints has to say the tab is open.
    store.set(propertiesPanelActiveTabAtom, "runs");
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
    store.set(propertiesPanelActiveTabAtom, "runs");
    store.set(executionOverlayGraphAtom, {
      nodes: [lifecycleNode("t")],
      edges: [],
    });
    store.set(setNodeStatusesAtom, [{ nodeId: "t", status: "error" }]);

    store.set(clearNodeStatusesAtom);

    expect(store.get(executionOverlayGraphAtom)).toBeNull();
    // An empty status map trips displayNodesAtom's fast path, so the draft's
    // node "a" comes back exactly as stored rather than carrying an explicit
    // "idle" -- equivalent to idle in every way that matters, since the node
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
    store.set(propertiesPanelActiveTabAtom, "runs");
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
