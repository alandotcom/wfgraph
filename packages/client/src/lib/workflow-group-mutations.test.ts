import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { groupStructureRefusalReason } from "@wfgraph/shared/graph/group-structure";
import { undersizedGroupIds } from "@wfgraph/shared/graph/node-group";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  applyAgentGraphAtom,
  copySelectionAtom,
  deleteEdgeAtom,
  deleteGroupWithMembersAtom,
  deleteNodeAtom,
  deleteSelectedItemsAtom,
  edgesAtom,
  groupSelectionAtom,
  installRemoteWorkflowAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  onNodesChangeAtom,
  pasteCopiedSelectionAtom,
  redoAtom,
  selectedNodeAtom,
  selectOnlyNodeAtom,
  snapshotHistoryAtom,
  undoAtom,
} from "#src/lib/workflow-graph-store";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  hasUnsavedChangesAtom,
  lastSaveErrorAtom,
  recordLoadedDraftRevisionAtom,
  saveWorkflowAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { activeAgentTurnIdAtom } from "#src/lib/workflow-ui-store";
import { nodesStateAtom } from "#src/lib/workflow-graph-cells";
import {
  toPersistedEdge,
  toPersistedNodes,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { savedWorkflow } from "./workflow-save-test-support";

type Store = ReturnType<typeof createStore>;
type Graph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

const updateMock = vi.fn(
  (_workflowId: string, _payload: Graph, _expectedDraftRevision: number) =>
    Promise.resolve(savedWorkflow("workflow_1"))
);
const turnId = Symbol("agent-turn");

beforeEach(() => {
  vi.clearAllMocks();
});

function lifecycle(): WorkflowNode {
  return {
    id: "life",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Start", type: "lifecycle", config: {} },
  };
}

function lookup(id: string, x = 0): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x, y: 200 },
    data: {
      label: id,
      type: "action",
      config: { actionType: "fountain/get-user" },
    },
  };
}

function condition(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 100, y: 400 },
    data: {
      label: id,
      type: "action",
      config: { actionType: BUILT_IN_ACTION_IDS.condition },
    },
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return omitUndefined({ id, source, target, sourceHandle });
}

/** Two lookups join at a Condition whose True branch reaches `after`. */
function ungroupedGraph(): Graph {
  return {
    nodes: [
      lifecycle(),
      lookup("a", 0),
      lookup("b", 200),
      condition("c"),
      { ...lookup("after", 100), position: { x: 100, y: 600 } },
    ],
    edges: [
      edge("start-a", "life", "a", "started"),
      edge("start-b", "life", "b", "started"),
      edge("a-c", "a", "c"),
      edge("b-c", "b", "c"),
      edge("c-after", "c", "after", "true"),
    ],
  };
}

function createGraphStore(graph: Graph): Store {
  const store = createStore();
  store.set(workflowApiAtom, { update: updateMock as never });
  store.set(autosaveDelayAtom, 0);
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(recordLoadedDraftRevisionAtom, {
    workflowId: "workflow_1",
    draftRevision: 1,
  });
  store.set(loadWorkflowGraphAtom, graph);
  return store;
}

/** The canvas after `a`, `b` and `c` are grouped, and the new frame's id. */
function groupedStore(): { store: Store; frameId: string } {
  const store = createGraphStore(ungroupedGraph());
  store.set(groupSelectionAtom, {
    catalog: emptyExtensionCatalog,
    selectedIds: new Set(["a", "b", "c"]),
  });
  const frameId = store.get(nodesAtom).find((node) => isGroupNode(node))?.id;
  if (!frameId) {
    throw new Error("expected the fixture to group");
  }
  vi.clearAllMocks();
  return { store, frameId };
}

/** Let a zero-delay debounce timer and a queued save drain. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function graphOf(store: Store): Graph {
  return { nodes: store.get(nodesAtom), edges: store.get(edgesAtom) };
}

/**
 * What a save checks, and what the server's draft decoding checks, plus the
 * rule that every writer on the canvas dissolves a Group left too small.
 */
function expectWholeGroups(graph: Graph) {
  expect(
    groupStructureRefusalReason({
      nodes: toPersistedNodes(graph.nodes),
      edges: graph.edges.map(toPersistedEdge),
    })
  ).toBeNull();
  expect(undersizedGroupIds(graph.nodes)).toEqual([]);
}

/** Every graph the store sent to `workflow.update`, each held to the Group rules. */
function expectEverySaveWhole() {
  expect(updateMock).toHaveBeenCalled();
  for (const [, payload] of updateMock.mock.calls) {
    expectWholeGroups(payload);
  }
}

function membersOf(store: Store, frameId: string): string[] {
  return store
    .get(nodesAtom)
    .filter((node) => node.parentId === frameId)
    .map((node) => node.id);
}

function edgeIds(store: Store): string[] {
  return store.get(edgesAtom).map((item) => item.id);
}

describe("Group mutations on the canvas", () => {
  it("deletes a member with its stored edges in one undo step", async () => {
    const { store, frameId } = groupedStore();
    const before = graphOf(store);

    store.set(deleteNodeAtom, "a");
    await tick();

    expect(membersOf(store, frameId)).toEqual(["b", "c"]);
    expect(edgeIds(store)).toEqual(["start-b", "b-c", "c-after"]);
    expectEverySaveWhole();

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
  });

  it("ungroups a Group left with one member in the delete's undo step", async () => {
    const { store, frameId } = groupedStore();
    store.set(deleteNodeAtom, "a");
    const withTwoMembers = graphOf(store);

    store.set(deleteNodeAtom, "b");
    await tick();

    const nodes = store.get(nodesAtom);
    // Freed members follow the steps that were never grouped, which is the
    // frames-first order `orderGroupParentsFirst` keeps.
    expect(nodes.map((node) => node.id)).toEqual(["life", "after", "c"]);
    expect(nodes.some((node) => node.parentId !== undefined)).toBe(false);
    expect(nodes.find((node) => node.id === "c")?.draggable).toBe(true);
    expect(edgeIds(store)).toEqual(["c-after"]);
    expectEverySaveWhole();

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(withTwoMembers);
    expect(membersOf(store, frameId)).toEqual(["b", "c"]);
  });

  it("ungroups when the Delete key removes members through React Flow", async () => {
    const { store } = groupedStore();
    const before = graphOf(store);

    // React Flow's own order: the undo snapshot, then the node pass. The
    // members' interior edges are locked, so React Flow offers no edge pass.
    store.set(snapshotHistoryAtom);
    store.set(onNodesChangeAtom, [
      { type: "remove", id: "a" },
      { type: "remove", id: "b" },
    ]);
    await tick();

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
      "life",
      "after",
      "c",
    ]);
    expect(edgeIds(store)).toEqual(["c-after"]);
    expectEverySaveWhole();

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
  });

  it("removes a frame by ungrouping it, keeping members and stored edges", async () => {
    const { store, frameId } = groupedStore();
    const before = graphOf(store);

    store.set(deleteNodeAtom, frameId);
    await tick();

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
      "life",
      "after",
      "a",
      "b",
      "c",
    ]);
    expect(store.get(edgesAtom)).toBe(before.edges);
    expectEverySaveWhole();

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
  });

  /** Select exactly `ids`, the way a box selection over the canvas does. */
  function boxSelect(store: Store, ids: readonly string[]) {
    store.set(
      onNodesChangeAtom,
      store.get(nodesAtom).map((node) => ({
        type: "select" as const,
        id: node.id,
        selected: ids.includes(node.id),
      }))
    );
  }

  it("deletes the selected members and ungroups a selected frame in one undo step", async () => {
    const { store, frameId } = groupedStore();
    boxSelect(store, [frameId, "a"]);
    const before = graphOf(store);

    store.set(deleteSelectedItemsAtom);
    await tick();

    const nodes = store.get(nodesAtom);
    expect(nodes.map((node) => [node.id, node.parentId])).toEqual([
      ["life", undefined],
      ["after", undefined],
      ["b", undefined],
      ["c", undefined],
    ]);
    expect(edgeIds(store)).toEqual(["start-b", "b-c", "c-after"]);
    expect(store.get(selectedNodeAtom)).toBeNull();
    expectEverySaveWhole();

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
  });

  it("deletes every selected member and removes the emptied frame", async () => {
    const { store, frameId } = groupedStore();
    boxSelect(store, [frameId, "a", "b", "c"]);

    store.set(deleteSelectedItemsAtom);
    await tick();

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
      "life",
      "after",
    ]);
    expect(store.get(edgesAtom)).toEqual([]);
    expectEverySaveWhole();
  });

  it("clears the selection naming a frame the delete dissolved", async () => {
    const { store, frameId } = groupedStore();
    store.set(deleteNodeAtom, "a");
    store.set(selectOnlyNodeAtom, frameId);
    expect(store.get(selectedNodeAtom)).toBe(frameId);

    store.set(deleteNodeAtom, "b");
    await tick();

    expect(store.get(nodesAtom).some((node) => node.id === frameId)).toBe(
      false
    );
    expect(store.get(selectedNodeAtom)).toBeNull();
  });

  it("runs no removal for a drag", () => {
    const { store, frameId } = groupedStore();
    // A frame holding one step is a state no canvas writer leaves behind, and
    // any removal pass would dissolve it. Seeding one directly shows that a
    // drag frame reaches no removal pass.
    store.set(
      nodesStateAtom,
      store.get(nodesAtom).filter((node) => node.id !== "a" && node.id !== "b")
    );
    const edges = store.get(edgesAtom);

    store.set(onNodesChangeAtom, [
      {
        type: "position",
        id: "after",
        position: { x: 40, y: 700 },
        dragging: true,
      },
    ]);

    const nodes = store.get(nodesAtom);
    expect(membersOf(store, frameId)).toEqual(["c"]);
    expect(nodes.find((node) => node.id === "after")?.position).toEqual({
      x: 40,
      y: 700,
    });
    expect(store.get(edgesAtom)).toBe(edges);
  });

  it("deletes a Group with its steps and their edges in one undo step", async () => {
    const { store, frameId } = groupedStore();
    const before = graphOf(store);

    expect(store.set(deleteGroupWithMembersAtom, frameId)).toBe(true);
    await tick();

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
      "life",
      "after",
    ]);
    expect(store.get(edgesAtom)).toEqual([]);
    expectEverySaveWhole();

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
    store.set(redoAtom);
    await tick();
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
      "life",
      "after",
    ]);
    expectEverySaveWhole();
  });

  it("refuses to delete steps through an id that names no frame", () => {
    const { store } = groupedStore();

    expect(store.set(deleteGroupWithMembersAtom, "a")).toBe(false);
    expect(membersOf(store, "a")).toEqual([]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("deletes a painted outlet edge and leaves the Group whole", async () => {
    const { store, frameId } = groupedStore();
    const before = graphOf(store);

    store.set(deleteEdgeAtom, "c-after");
    await tick();

    expect(membersOf(store, frameId)).toEqual(["a", "b", "c"]);
    expect(edgeIds(store)).toEqual(["start-a", "start-b", "a-c", "b-c"]);
    expectEverySaveWhole();

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
  });

  it("saves only whole Groups across undo and redo of a dissolution", async () => {
    const { store } = groupedStore();
    store.set(deleteNodeAtom, "a");
    store.set(deleteNodeAtom, "b");
    store.set(undoAtom);
    store.set(undoAtom);
    store.set(redoAtom);
    store.set(redoAtom);
    await tick();

    expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
      "life",
      "after",
      "c",
    ]);
    expectEverySaveWhole();
  });

  it("pastes a copied Group with its own frame, membership and edge ids", async () => {
    const { store, frameId } = groupedStore();
    store.set(selectOnlyNodeAtom, frameId);
    store.set(copySelectionAtom);

    store.set(pasteCopiedSelectionAtom);
    await tick();

    const nodes = store.get(nodesAtom);
    const frames = nodes.filter((node) => isGroupNode(node));
    expect(frames).toHaveLength(2);
    const pastedFrame = frames.find((node) => node.id !== frameId);
    if (!pastedFrame) {
      throw new Error("expected a pasted frame");
    }
    // The frame stores its label and kind alone. Its boundary is read from
    // the pasted members and edges, so no cached entry or exit travels.
    expect(pastedFrame.data).toEqual({ label: "Group", type: "group" });

    const pastedMembers = nodes.filter(
      (node) => node.parentId === pastedFrame.id
    );
    expect(pastedMembers.map((node) => node.data.label)).toEqual([
      "a",
      "b",
      "c",
    ]);
    const pastedIds = new Set(pastedMembers.map((node) => node.id));
    expect([...pastedIds].some((id) => ["a", "b", "c"].includes(id))).toBe(
      false
    );

    const pastedEdges = store
      .get(edgesAtom)
      .filter((item) => pastedIds.has(item.source));
    expect(pastedEdges).toHaveLength(2);
    for (const pasted of pastedEdges) {
      expect(["a-c", "b-c"]).not.toContain(pasted.id);
      expect(pastedIds.has(pasted.target)).toBe(true);
    }
    expect(new Set(edgeIds(store)).size).toBe(store.get(edgesAtom).length);
    expectEverySaveWhole();
  });
});

describe("Group rules for graphs from outside the canvas", () => {
  function agentStore(): Store {
    const store = createGraphStore(ungroupedGraph());
    store.set(activeAgentTurnIdAtom, turnId);
    return store;
  }

  function frame(): WorkflowNode {
    return {
      id: "g",
      type: "group",
      position: { x: 0, y: 150 },
      width: 400,
      height: 300,
      data: { label: "Group", type: "group" },
    };
  }

  function member(node: WorkflowNode, parentId = "g"): WorkflowNode {
    return { ...node, parentId, extent: "parent", draggable: false };
  }

  it("ungroups a Group an agent edit left with one member before saving", async () => {
    const store = agentStore();

    expect(
      store.set(applyAgentGraphAtom, {
        workflowId: "workflow_1",
        turnId,
        recordHistory: true,
        nodes: [lifecycle(), frame(), member(lookup("a")), lookup("after")],
        edges: [
          edge("start-a", "life", "a", "started"),
          edge("a-after", "a", "after"),
        ],
        catalog: emptyExtensionCatalog,
      })
    ).toBe(true);
    await tick();

    const nodes = store.get(nodesAtom);
    expect(nodes.map((node) => node.id).sort()).toEqual(["a", "after", "life"]);
    expect(nodes.find((node) => node.id === "a")).not.toHaveProperty(
      "parentId"
    );
    expectEverySaveWhole();
  });

  it("refuses an agent graph whose member names a missing frame", async () => {
    const store = agentStore();
    const before = graphOf(store);

    expect(
      store.set(applyAgentGraphAtom, {
        workflowId: "workflow_1",
        turnId,
        recordHistory: true,
        nodes: [
          lifecycle(),
          member(lookup("a"), "gone"),
          member(lookup("b"), "gone"),
        ],
        edges: [],
        catalog: emptyExtensionCatalog,
      })
    ).toBe(false);
    await tick();

    expect(graphOf(store)).toEqual(before);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("ungroups an undersized Group in a draft revision installed from the server", () => {
    const store = createGraphStore(ungroupedGraph());

    const installed = store.set(installRemoteWorkflowAtom, {
      ...savedWorkflow("workflow_1", {
        nodes: [lifecycle(), frame(), member(lookup("a"))],
        edges: [edge("start-a", "life", "a", "started")],
      }),
      draftRevision: 2,
    });

    expect(installed).toBe(true);
    const nodes = store.get(nodesAtom);
    expect(nodes.map((node) => node.id)).toEqual(["life", "a"]);
    expectWholeGroups(graphOf(store));
    // The install sends nothing itself. The repaired graph differs from the
    // stored draft, so it is left unsaved for the next save to write.
    expect(updateMock).not.toHaveBeenCalled();
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
  });

  it("marks a loaded graph unsaved only when loading dissolved a Group", () => {
    const repaired = createGraphStore({
      nodes: [lifecycle(), frame(), member(lookup("a"))],
      edges: [edge("start-a", "life", "a", "started")],
    });
    expect(repaired.get(nodesAtom).map((node) => node.id)).toEqual([
      "life",
      "a",
    ]);
    expect(repaired.get(hasUnsavedChangesAtom)).toBe(true);

    const whole = createGraphStore({
      nodes: [lifecycle(), frame(), member(lookup("a")), member(lookup("b"))],
      edges: [edge("start-a", "life", "a", "started")],
    });
    expect(whole.get(nodesAtom).map((node) => node.id)).toEqual([
      "life",
      "g",
      "a",
      "b",
    ]);
    expect(whole.get(hasUnsavedChangesAtom)).toBe(false);
  });

  /** A Group whose stored edge names the frame, which a draft save refuses. */
  function edgeOntoFrameGraph(): Graph {
    return {
      nodes: [lifecycle(), frame(), member(lookup("a")), member(lookup("b"))],
      edges: [edge("start-g", "life", "g", "started")],
    };
  }

  it("saves a Group that breaks only the Publish rules", async () => {
    const store = createGraphStore(ungroupedGraph());

    const outcome = await store.set(
      saveWorkflowAtom,
      { nodes: [lifecycle(), frame(), member(lookup("a"))], edges: [] },
      { immediate: true }
    );

    expect(outcome?.ok).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to save a Group structure the server's draft save refuses", async () => {
    const store = createGraphStore(ungroupedGraph());

    const outcome = await store.set(saveWorkflowAtom, edgeOntoFrameGraph(), {
      immediate: true,
    });

    expect(outcome?.ok).toBe(false);
    expect(store.get(lastSaveErrorAtom)?.message).toBe(
      outcome?.ok === false ? outcome.error.message : undefined
    );
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("keeps a refused graph unsaved when an older queued save lands", async () => {
    const store = createGraphStore(ungroupedGraph());

    // A debounced save of a valid graph is still queued when the next graph
    // is refused, and that older save then succeeds.
    const queued = store.set(saveWorkflowAtom, ungroupedGraph());
    const refused = await store.set(saveWorkflowAtom, edgeOntoFrameGraph());
    expect(refused?.ok).toBe(false);
    expect((await queued)?.ok).toBe(true);

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
    expect(store.get(lastSaveErrorAtom)).toBe(
      refused?.ok === false ? refused.error : undefined
    );

    // An accepted graph queued after the refusal is what clears it.
    const accepted = await store.set(saveWorkflowAtom, ungroupedGraph(), {
      immediate: true,
    });
    expect(accepted?.ok).toBe(true);
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(lastSaveErrorAtom)).toBeNull();
  });
});
