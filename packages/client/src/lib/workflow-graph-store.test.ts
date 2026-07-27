import { beforeEach, describe, expect, it, vi } from "bun:test";
import type { createStore as createJotaiStore } from "jotai";
import { createStore } from "jotai";
import {
  addNodeAtom,
  applyNodeLayoutAtom,
  canUndoAtom,
  clearWorkflowAtom,
  connectNodesAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
  deleteSelectedItemsAtom,
  edgesAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  onEdgesChangeAtom,
  onNodesChangeAtom,
  snapshotHistoryAtom,
  undoAtom,
} from "@/lib/workflow-graph-store";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  hasUnsavedChangesAtom,
  workflowApiAtom,
} from "@/lib/workflow-save-store";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/workflow/types";
import { savedWorkflow } from "./workflow-save-test-support";

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

function triggerNode(id: string): WorkflowNode {
  return {
    id,
    type: "trigger",
    position: { x: 0, y: 0 },
    data: { label: id, type: "trigger" },
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
    [triggerNode("t"), actionNode("a"), actionNode("b")],
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
 * Every way the graph can change has to be both undoable and persisted. These
 * two properties used to be decided per call site, which is how creating an
 * edge ended up saved but not undoable.
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
    const store = createGraphStore([triggerNode("t")], []);

    // A trigger cannot be deleted, so this is a no-op and must not consume an
    // undo step or fire a save.
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
  it("keeps the trigger", () => {
    const store = createGraphStore(...standardGraph());

    store.set(clearWorkflowAtom);

    // A graph with no trigger is one the server always rejects, so clearing has
    // to stop short of removing it.
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["t"]);
    expect(store.get(edgesAtom)).toEqual([]);
  });
});
