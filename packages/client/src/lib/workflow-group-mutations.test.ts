import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { groupStructureRefusalReason } from "@wfgraph/shared/graph/group-structure";
import { groupContractViolations } from "@wfgraph/shared/graph/group-contract";
import { undersizedGroupIds } from "@wfgraph/shared/graph/node-group";
import { workflowTopologyRefusalReason } from "@wfgraph/shared/graph/workflow-topology";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  connectionRefusalReason,
  planConnection,
} from "#src/components/workflow/connection-validation";
import {
  boundaryStubId,
  storedCanvasConnection,
} from "#src/lib/group-scope-canvas";
import {
  applyAgentGraphAtom,
  canvasEdgesAtom,
  canvasNodesAtom,
  connectNodesAtom,
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
  onEdgesChangeAtom,
  onNodesChangeAtom,
  pasteCopiedSelectionAtom,
  redoAtom,
  selectedNodeAtom,
  selectOnlyNodeAtom,
  setGroupDirectionAtom,
  snapshotHistoryAtom,
  undoAtom,
  ungroupNodeAtom,
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
import {
  toPersistedEdge,
  toPersistedNodes,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { historyAtom, nodesStateAtom } from "#src/lib/workflow-graph-cells";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  activeWorkspaceCamerasAtom,
  recordWorkspaceCameraAtom,
} from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
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
    expect(nodes.find((node) => node.id === "c")).not.toHaveProperty(
      "draggable"
    );
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
    expect(pastedFrame.data).toEqual({
      label: "Group",
      type: "group",
      config: { direction: "vertical" },
    });

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

/**
 * A linear chain holding a lookup, a side-effecting send that is switched off,
 * and a Wait, entered from the Lifecycle Node and continuing to `after`.
 */
function linearGraph(): Graph {
  const step = (
    id: string,
    y: number,
    config: Record<string, unknown>,
    enabled?: boolean
  ): WorkflowNode => ({
    id,
    type: "action",
    position: { x: 0, y },
    data: omitUndefined({ label: id, type: "action", config, enabled }),
  });
  return {
    nodes: [
      lifecycle(),
      step("read", 200, { actionType: "fountain/get-user" }),
      step("send", 400, { actionType: "resend/send-email" }, false),
      step("wait", 600, {
        actionType: BUILT_IN_ACTION_IDS.wait,
        waitMode: "delay",
        waitDuration: "1h",
      }),
      step("after", 800, { actionType: "fountain/get-user" }),
    ],
    edges: [
      edge("start-read", "life", "read", "started"),
      edge("read-send", "read", "send"),
      edge("send-wait", "send", "wait"),
      edge("wait-after", "wait", "after"),
    ],
  };
}

/** The last graph the store sent to `workflow.update`. */
function lastSaved(): Graph {
  const payload = updateMock.mock.calls.at(-1)?.[1];
  if (!payload) {
    throw new Error("expected a save");
  }
  return payload;
}

describe("linear Groups", () => {
  it("groups a lookup, a side-effecting action and a Wait as one undo step that saves", async () => {
    const store = createGraphStore(linearGraph());
    const before = graphOf(store);

    expect(
      store.set(groupSelectionAtom, {
        selectedIds: new Set(["read", "send", "wait"]),
      })
    ).toBe(true);
    await tick();

    const frame = store.get(nodesAtom).find((node) => isGroupNode(node));
    expect(frame?.data.config).toEqual({ direction: "vertical" });
    expect(membersOf(store, frame?.id ?? "")).toEqual(["read", "send", "wait"]);
    // Grouping writes membership only: the stored edges and each step's own
    // data, its switched-off state included, are what they were.
    expect(store.get(edgesAtom)).toEqual(before.edges);
    for (const node of before.nodes) {
      expect(
        store.get(nodesAtom).find((item) => item.id === node.id)?.data
      ).toEqual(node.data);
    }
    const saved = lastSaved();
    expect(saved.nodes.find((node) => isGroupNode(node))?.data.config).toEqual({
      direction: "vertical",
    });
    expect(
      groupContractViolations({
        nodes: toPersistedNodes(saved.nodes),
        edges: saved.edges.map(toPersistedEdge),
      })
    ).toEqual([]);
    expectEverySaveWhole();

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
  });

  it("changes a Group's direction as one undo step that saves", async () => {
    const store = createGraphStore(linearGraph());
    store.set(groupSelectionAtom, {
      selectedIds: new Set(["read", "send", "wait"]),
    });
    const frameId = store.get(nodesAtom).find((node) => isGroupNode(node))?.id;
    if (!frameId) {
      throw new Error("expected the chain to group");
    }
    await tick();
    vi.clearAllMocks();
    const grouped = graphOf(store);

    expect(
      store.set(setGroupDirectionAtom, {
        groupId: frameId,
        direction: "horizontal",
      })
    ).toBe(true);
    await tick();

    const frameOf = (graph: Graph) =>
      graph.nodes.find((node) => node.id === frameId);
    expect(frameOf(graphOf(store))?.data.config).toEqual({
      direction: "horizontal",
    });
    expect(frameOf(lastSaved())?.data.config).toEqual({
      direction: "horizontal",
    });
    expect(store.get(edgesAtom)).toEqual(grouped.edges);
    expect(membersOf(store, frameId)).toEqual(["read", "send", "wait"]);
    expect(updateMock).toHaveBeenCalledTimes(1);

    // Choosing the direction the frame already stores records nothing.
    expect(
      store.set(setGroupDirectionAtom, {
        groupId: frameId,
        direction: "horizontal",
      })
    ).toBe(false);

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(grouped);
    store.set(redoAtom);
    expect(frameOf(graphOf(store))?.data.config).toEqual({
      direction: "horizontal",
    });
  });

  it("writes nothing when the shown direction is chosen on a frame that stores none", async () => {
    const store = createGraphStore(linearGraph());
    store.set(groupSelectionAtom, {
      selectedIds: new Set(["read", "send", "wait"]),
    });
    const frameId =
      store.get(nodesAtom).find((node) => isGroupNode(node))?.id ?? "";
    store.set(
      nodesStateAtom,
      store
        .get(nodesStateAtom)
        .map((node) =>
          node.id === frameId
            ? { ...node, data: { label: "Group", type: "group" } }
            : node
        )
    );
    await tick();
    vi.clearAllMocks();
    const history = store.get(historyAtom);
    const nodes = store.get(nodesAtom);

    expect(
      store.set(setGroupDirectionAtom, {
        groupId: frameId,
        direction: "vertical",
      })
    ).toBe(false);
    await tick();

    expect(store.get(nodesAtom)).toBe(nodes);
    expect(store.get(historyAtom)).toBe(history);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("fits a Group's focused canvas again after its direction flips, and after the flip is undone", () => {
    const store = createGraphStore(linearGraph());
    store.set(groupSelectionAtom, {
      selectedIds: new Set(["read", "send", "wait"]),
    });
    const groupId =
      store.get(nodesAtom).find((node) => isGroupNode(node))?.id ?? "";
    const camera = { centerX: 40, centerY: 300, zoom: 1.2 };
    const enterAndLook = () => {
      showWorkspaceRoute(store, { group: groupId });
      const address = store.get(activeWorkspaceAddressAtom);
      for (const formFactor of ["desktop", "mobile"] as const) {
        store.set(recordWorkspaceCameraAtom, { address, formFactor, camera });
      }
      expect(store.get(activeWorkspaceCamerasAtom)).toEqual({
        desktop: camera,
        mobile: camera,
      });
    };

    enterAndLook();
    showWorkspaceRoute(store, {});
    store.set(setGroupDirectionAtom, { groupId, direction: "horizontal" });
    showWorkspaceRoute(store, { group: groupId });
    expect(store.get(activeWorkspaceCamerasAtom)).toEqual({
      desktop: null,
      mobile: null,
    });

    enterAndLook();
    showWorkspaceRoute(store, {});
    store.set(undoAtom);
    showWorkspaceRoute(store, { group: groupId });
    expect(store.get(activeWorkspaceCamerasAtom)).toEqual({
      desktop: null,
      mobile: null,
    });

    enterAndLook();
    showWorkspaceRoute(store, {});
    store.set(redoAtom);
    showWorkspaceRoute(store, { group: groupId });
    expect(store.get(activeWorkspaceCamerasAtom)).toEqual({
      desktop: null,
      mobile: null,
    });

    // Choosing the direction the Group already has keeps the saved cameras.
    enterAndLook();
    showWorkspaceRoute(store, {});
    store.set(setGroupDirectionAtom, { groupId, direction: "horizontal" });
    showWorkspaceRoute(store, { group: groupId });
    expect(store.get(activeWorkspaceCamerasAtom)).toEqual({
      desktop: camera,
      mobile: camera,
    });
  });

  it("ungroups a horizontal Group along its direction, keeping edges and step data", async () => {
    const store = createGraphStore(linearGraph());
    const before = graphOf(store);
    store.set(groupSelectionAtom, {
      selectedIds: new Set(["read", "send", "wait"]),
    });
    const frameId =
      store.get(nodesAtom).find((node) => isGroupNode(node))?.id ?? "";
    store.set(setGroupDirectionAtom, {
      groupId: frameId,
      direction: "horizontal",
    });

    expect(store.set(ungroupNodeAtom, frameId)).toBe(true);
    await tick();

    const nodes = store.get(nodesAtom);
    const positionOf = (id: string) =>
      nodes.find((node) => node.id === id)?.position;
    expect(nodes.some((node) => isGroupNode(node))).toBe(false);
    expect(positionOf("read")?.y).toBe(positionOf("send")?.y);
    expect(positionOf("read")?.x ?? 0).toBeLessThan(positionOf("send")?.x ?? 0);
    expect(store.get(edgesAtom)).toEqual(before.edges);
    expect(nodes.find((node) => node.id === "send")?.data.enabled).toBe(false);
    expect(lastSaved().nodes.some((node) => isGroupNode(node))).toBe(false);
  });

  it("deletes and reconnects an interior edge between stored members", async () => {
    const store = createGraphStore(linearGraph());
    store.set(groupSelectionAtom, {
      selectedIds: new Set(["read", "send", "wait"]),
    });
    const frameId =
      store.get(nodesAtom).find((node) => isGroupNode(node))?.id ?? "";
    await tick();
    const grouped = graphOf(store);

    // The focused canvas paints the stored interior edge itself, so React
    // Flow's removal names the stored id.
    store.set(snapshotHistoryAtom);
    store.set(onEdgesChangeAtom, [{ type: "remove", id: "send-wait" }]);
    await tick();
    expect(edgeIds(store)).toEqual(["start-read", "read-send", "wait-after"]);
    expect(lastSaved().edges.map((item) => item.id)).not.toContain("send-wait");

    // A projected member keeps its stored id, so the connection it makes
    // names the members and saves as an interior edge.
    store.set(connectNodesAtom, {
      connection: { id: "send-wait-again", source: "send", target: "wait" },
      catalog: emptyExtensionCatalog,
    });
    await tick();
    expect(store.get(edgesAtom).at(-1)).toEqual({
      id: "send-wait-again",
      source: "send",
      target: "wait",
      sourceHandle: null,
    });
    expect(membersOf(store, frameId)).toEqual(["read", "send", "wait"]);
    expectEverySaveWhole();

    store.set(undoAtom);
    store.set(undoAtom);
    expect(graphOf(store)).toEqual(grouped);
  });
});

/**
 * `qualify` fans out onto the lookups `read` and `profile`, and `read` feeds
 * `send`, which continues to `after`. `other` is a second outside step.
 */
function fanOutGraph(): Graph {
  return {
    nodes: [
      lifecycle(),
      { ...lookup("qualify", 100), position: { x: 100, y: 100 } },
      { ...lookup("other", 400), position: { x: 400, y: 100 } },
      lookup("read", 0),
      lookup("profile", 200),
      { ...lookup("send", 0), position: { x: 0, y: 400 } },
      { ...lookup("after", 0), position: { x: 0, y: 600 } },
    ],
    edges: [
      edge("start-qualify", "life", "qualify", "started"),
      edge("start-other", "life", "other", "started"),
      edge("qualify-read", "qualify", "read"),
      edge("qualify-profile", "qualify", "profile"),
      edge("read-send", "read", "send"),
      edge("send-after", "send", "after"),
    ],
  };
}

/** `fanOutGraph` with `read`, `profile` and `send` grouped, saves cleared. */
function groupedFanOut(): { store: Store; frameId: string; grouped: Graph } {
  const store = createGraphStore(fanOutGraph());
  store.set(groupSelectionAtom, {
    selectedIds: new Set(["read", "profile", "send"]),
  });
  const frameId =
    store.get(nodesAtom).find((node) => isGroupNode(node))?.id ?? "";
  vi.clearAllMocks();
  return { store, frameId, grouped: graphOf(store) };
}

describe("parallel ingress fan-out", () => {
  it("groups a fan-out that Publish accepts and paints one inlet on the card", () => {
    const { store, frameId, grouped } = groupedFanOut();

    expect(grouped.edges).toEqual(fanOutGraph().edges);
    expect(groupContractViolations(grouped)).toEqual([]);
    const intoCard = store
      .get(canvasEdgesAtom)
      .filter((item) => item.target === frameId);
    expect(intoCard.map((item) => [item.id, item.source])).toEqual([
      ["qualify-read", "qualify"],
    ]);
  });

  it("deletes the painted inlet with every edge it stands for, and reconnects the same fan-out", async () => {
    const { store, frameId, grouped } = groupedFanOut();

    store.set(snapshotHistoryAtom);
    store.set(onEdgesChangeAtom, [{ type: "remove", id: "qualify-read" }]);
    await tick();
    const withoutIngress = graphOf(store);
    expect(edgeIds(store)).toEqual([
      "start-qualify",
      "start-other",
      "read-send",
      "send-after",
    ]);
    expect(lastSaved().edges).toEqual(withoutIngress.edges);

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(grouped);
    store.set(redoAtom);

    // Replacing the source: the card's inlet enters the members no interior
    // edge reaches, which are the two lookups the old fan-out entered.
    store.set(connectNodesAtom, {
      connection: { id: "other-in", source: "other", target: frameId },
      catalog: emptyExtensionCatalog,
    });
    await tick();
    expect(
      store
        .get(edgesAtom)
        .filter((item) => item.source === "other")
        .map((item) => [item.source, item.target])
    ).toEqual([
      ["other", "read"],
      ["other", "profile"],
    ]);
    expect(lastSaved().edges).toEqual(store.get(edgesAtom));
    expect(groupContractViolations(graphOf(store))).toEqual([]);
    expectEverySaveWhole();

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(withoutIngress);
  });

  it("refuses to enter the Group from a second outside outlet", async () => {
    const { store, frameId, grouped } = groupedFanOut();
    const connection = {
      source: "other",
      target: frameId,
      sourceHandle: null,
      targetHandle: null,
    };

    expect(
      connectionRefusalReason({
        connection,
        nodes: store.get(nodesAtom),
        storeEdges: store.get(edgesAtom),
        catalog: emptyExtensionCatalog,
      })
    ).toBe(
      'The Group "Group" is already entered from "qualify". A Group is entered from one outlet, so remove that connection first.'
    );
    const history = store.get(historyAtom);
    expect(
      store.set(connectNodesAtom, {
        connection: { id: "other-in", ...connection },
        catalog: emptyExtensionCatalog,
      })
    ).toEqual({
      refusal:
        'The Group "Group" is already entered from "qualify". A Group is entered from one outlet, so remove that connection first.',
    });
    await tick();

    expect(graphOf(store)).toEqual(grouped);
    expect(store.get(historyAtom)).toBe(history);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("deletes and adds one child connection from the focused canvas", async () => {
    const { store, frameId, grouped } = groupedFanOut();
    showWorkspaceRoute(store, { group: frameId });

    // The focused canvas paints each ingress edge under its stored id, so the
    // removal takes that edge and leaves its sibling.
    store.set(snapshotHistoryAtom);
    store.set(onEdgesChangeAtom, [{ type: "remove", id: "qualify-profile" }]);
    await tick();
    expect(edgeIds(store)).toEqual([
      "start-qualify",
      "start-other",
      "qualify-read",
      "read-send",
      "send-after",
    ]);
    expect(lastSaved().edges).toEqual(store.get(edgesAtom));

    // Once `qualify` enters the Group, a connection onto the collapsed card
    // reaches only `read`, so the refusal points at the "Incoming from" stub.
    expect(
      connectionRefusalReason({
        connection: { source: "qualify", target: frameId },
        nodes: store.get(nodesAtom),
        storeEdges: store.get(edgesAtom),
        catalog: emptyExtensionCatalog,
      })
    ).toBe(
      'This outlet already enters the Group. To connect it to another step inside, open the Group and drag from its "Incoming from" stub.'
    );

    // A drag from the ingress stub onto `profile` names the stub.
    const translated = storedCanvasConnection(
      {
        source: boundaryStubId("ingress", { nodeId: "qualify", handle: null }),
        target: "profile",
        sourceHandle: null,
        targetHandle: null,
      },
      store.get(canvasNodesAtom)
    );
    if ("refusal" in translated) {
      throw new Error("expected the stub drag to store a connection");
    }
    expect(
      connectionRefusalReason({
        ...translated,
        nodes: store.get(nodesAtom),
        storeEdges: store.get(edgesAtom),
        catalog: emptyExtensionCatalog,
      })
    ).toBeNull();
    store.set(connectNodesAtom, {
      connection: { id: "again", ...translated.connection },
      fromIngressStub: translated.fromIngressStub,
      catalog: emptyExtensionCatalog,
    });
    await tick();
    expect(store.get(edgesAtom).at(-1)).toEqual({
      id: "again",
      source: "qualify",
      target: "profile",
      sourceHandle: null,
      targetHandle: null,
    });
    expect(groupContractViolations(graphOf(store))).toEqual([]);

    // Deleting a selected ingress edge in the focused scope takes that edge.
    store.set(activeSelectionAtom, { nodeIds: [], edgeIds: ["qualify-read"] });
    store.set(deleteSelectedItemsAtom);
    await tick();
    expect(
      store
        .get(edgesAtom)
        .filter((item) => item.source === "qualify")
        .map((item) => item.id)
    ).toEqual(["again"]);
    expectEverySaveWhole();

    store.set(undoAtom);
    expect(edgeIds(store)).toEqual([
      "start-qualify",
      "start-other",
      "qualify-read",
      "read-send",
      "send-after",
      "again",
    ]);
    store.set(undoAtom);
    expect(edgeIds(store)).toEqual([
      "start-qualify",
      "start-other",
      "qualify-read",
      "read-send",
      "send-after",
    ]);
    store.set(undoAtom);
    expect(graphOf(store)).toEqual(grouped);
  });
});

describe("connection planning", () => {
  it("stores exactly the additions the preview planned against the same graph", async () => {
    const { store, frameId } = groupedFanOut();
    store.set(onEdgesChangeAtom, [{ type: "remove", id: "qualify-read" }]);
    await tick();
    const connection = { source: "other", target: frameId };
    const preview = planConnection({
      connection,
      nodes: store.get(nodesAtom),
      storeEdges: store.get(edgesAtom),
      catalog: emptyExtensionCatalog,
    });

    const committed = store.set(connectNodesAtom, {
      connection: { id: "other-in", ...connection },
      catalog: emptyExtensionCatalog,
    });

    expect(committed).toEqual(preview);
    if (committed === null || "refusal" in committed) {
      throw new Error("expected the connection to be stored");
    }
    expect(
      store
        .get(edgesAtom)
        .filter((item) => item.source === "other" && item.target !== "other")
        .map(({ id: _id, ...addition }) => addition)
        .slice(-committed.additions.length)
    ).toEqual(committed.additions);
  });

  it("refuses at commit a member connected to a step outside its Group, which the preview refuses", async () => {
    const { store, grouped } = groupedFanOut();
    const history = store.get(historyAtom);

    expect(
      store.set(connectNodesAtom, {
        connection: { id: "leak", source: "other", target: "send" },
        catalog: emptyExtensionCatalog,
      })
    ).toEqual({
      refusal:
        "Connect two steps inside the same Group, or connect the Group card.",
    });
    await tick();
    expect(graphOf(store)).toEqual(grouped);
    expect(store.get(historyAtom)).toBe(history);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("refuses at commit a join the draft save refuses", async () => {
    const store = createGraphStore({
      nodes: [lifecycle(), lookup("started", 0), lookup("canceled", 200)],
      edges: [
        edge("life-started", "life", "started", "started"),
        edge("life-canceled", "life", "canceled", "canceled"),
      ],
    });
    const before = graphOf(store);

    expect(
      store.set(connectNodesAtom, {
        connection: { id: "join", source: "canceled", target: "started" },
        catalog: emptyExtensionCatalog,
      })
    ).toEqual({
      refusal: 'Node "started" cannot join the Started and Canceled branches',
    });
    await tick();
    expect(graphOf(store)).toEqual(before);
  });
});

/**
 * `qualify` enters a Group at `a`, which fans out unconditionally to `b`, `e`
 * and the delay Wait `w`, and to the Condition `c`, whose branches reach `k`
 * and `m`. `b` feeds `j`, which continues to `send`. `e`, `w`, `k` and `m` end
 * their paths inside the Group.
 */
function joinGraph(): Graph {
  const wait: WorkflowNode = {
    ...lookup("w"),
    data: {
      label: "w",
      type: "action",
      config: {
        actionType: BUILT_IN_ACTION_IDS.wait,
        waitMode: "delay",
        waitDuration: "1h",
      },
    },
  };
  return {
    nodes: [
      lifecycle(),
      lookup("qualify"),
      lookup("a"),
      lookup("b"),
      lookup("e"),
      wait,
      condition("c"),
      lookup("k"),
      lookup("m"),
      lookup("j"),
      lookup("send"),
    ],
    edges: [
      edge("start-qualify", "life", "qualify", "started"),
      edge("qualify-a", "qualify", "a"),
      edge("a-b", "a", "b"),
      edge("a-e", "a", "e"),
      edge("a-w", "a", "w"),
      edge("a-c", "a", "c"),
      edge("c-k", "c", "k", "true"),
      edge("c-m", "c", "m", "false"),
      edge("b-j", "b", "j"),
      edge("j-send", "j", "send"),
    ],
  };
}

describe("joins inside a Group", () => {
  function focusedJoinGroup() {
    const store = createGraphStore(joinGraph());
    store.set(groupSelectionAtom, {
      selectedIds: new Set(["a", "b", "e", "w", "c", "k", "m", "j"]),
    });
    const frameId =
      store.get(nodesAtom).find((node) => isGroupNode(node))?.id ?? "";
    expect(frameId).not.toBe("");
    showWorkspaceRoute(store, { group: frameId });
    vi.clearAllMocks();
    return { store, frameId };
  }

  /** The refusal for a drag on the focused canvas from `source` onto `target`. */
  function dragRefusal(
    store: Store,
    source: string,
    target: string
  ): string | null {
    const translated = storedCanvasConnection(
      { source, target, sourceHandle: null, targetHandle: null },
      store.get(canvasNodesAtom)
    );
    if ("refusal" in translated) {
      return translated.refusal;
    }
    return connectionRefusalReason({
      ...translated,
      nodes: store.get(nodesAtom),
      storeEdges: store.get(edgesAtom),
      catalog: emptyExtensionCatalog,
    });
  }

  /** The stored graph with one more edge, as Publish or the draft save reads it. */
  function withEdge(store: Store, source: string, target: string): Graph {
    const graph = graphOf(store);
    return {
      nodes: graph.nodes,
      edges: [...graph.edges, edge(`${source}-${target}`, source, target)],
    };
  }

  it("converges an unconditional fan-out on a join that continues through one port", async () => {
    const { store } = focusedJoinGroup();

    expect(dragRefusal(store, "e", "j")).toBeNull();
    store.set(connectNodesAtom, {
      connection: { id: "e-j", source: "e", target: "j" },
      catalog: emptyExtensionCatalog,
    });
    await tick();

    expect(edgeIds(store)).toContain("e-j");
    expect(groupContractViolations(graphOf(store))).toEqual([]);
    expectEverySaveWhole();
    const y = (id: string) =>
      store.get(canvasNodesAtom).find((node) => node.id === id)?.position.y ??
      Number.NaN;
    expect(y("j")).toBeGreaterThan(Math.max(y("b"), y("e")));
  });

  it("refuses a branch into an inside join from the Group's outside port, as Publish does", async () => {
    const { store } = focusedJoinGroup();
    const history = store.get(historyAtom);

    const refusal = dragRefusal(
      store,
      boundaryStubId("ingress", { nodeId: "qualify", handle: null }),
      "j"
    );
    const [violation] = groupContractViolations(
      withEdge(store, "qualify", "j")
    );
    expect(violation?.rule).toBe("join_crosses_boundary");
    expect(refusal).toBe(`${violation?.message}.`);

    expect(
      store.set(connectNodesAtom, {
        connection: { id: "qualify-j", source: "qualify", target: "j" },
        fromIngressStub: true,
        catalog: emptyExtensionCatalog,
      })
    ).toEqual({ refusal });
    await tick();
    expect(edgeIds(store)).not.toContain("qualify-j");
    expect(store.get(historyAtom)).toBe(history);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("refuses a Wait on a join arm with the draft save's own reason", () => {
    const { store } = focusedJoinGroup();

    const refusal = dragRefusal(store, "w", "j");
    expect(refusal).toBe(
      workflowTopologyRefusalReason(persisted(withEdge(store, "w", "j")))
    );
    expect(refusal).toContain("cannot join branches that include a Wait");
  });

  it("refuses a join arm a Condition can leave unreached, as Publish does", async () => {
    const { store } = focusedJoinGroup();

    const refusal = dragRefusal(store, "k", "j");
    const [violation] = groupContractViolations(withEdge(store, "k", "j"));
    expect(violation?.rule).toBe("conditional_join_arm");
    expect(refusal).toBe(`${violation?.message}.`);

    expect(
      store.set(connectNodesAtom, {
        connection: { id: "k-j", source: "k", target: "j" },
        catalog: emptyExtensionCatalog,
      })
    ).toEqual({ refusal });
    await tick();
    expect(edgeIds(store)).not.toContain("k-j");
    expect(updateMock).not.toHaveBeenCalled();
  });
});

function persisted(graph: Graph) {
  return {
    nodes: toPersistedNodes(graph.nodes),
    edges: graph.edges.map(toPersistedEdge),
  };
}
