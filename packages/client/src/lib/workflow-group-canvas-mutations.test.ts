import { beforeEach, describe, expect, it, vi } from "vitest";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { boundaryStubId } from "#src/lib/group-scope-canvas";
import { overlappingCardIds } from "@wfgraph/shared/graph/node-placement-test-support";
import {
  addConnectedNodeAtom,
  addNodeAtom,
  addStepAfterAtom,
  canvasEdgesAtom,
  insertStepOnEdgeAtom,
  canvasNodesAtom,
  copySelectionAtom,
  deleteEdgeAtom,
  deleteGroupWithMembersAtom,
  deleteNodeAtom,
  deleteSelectedItemsAtom,
  duplicateSelectionAtom,
  edgesAtom,
  groupSelectionAtom,
  nodesAtom,
  onNodesChangeAtom,
  pasteCopiedSelectionAtom,
  redoAtom,
  selectedNodeAtom,
  selectOnlyNodeAtom,
  deleteCanvasSelectionAtom,
  undoAtom,
  ungroupNodeAtom,
} from "#src/lib/workflow-graph-store";
import { historyAtom, nodesStateAtom } from "#src/lib/workflow-graph-cells";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
} from "#src/lib/workflow-node-dimensions";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import {
  updateMock,
  ungroupedGraph,
  lifecycle,
  lookup,
  edge,
  createGraphStore,
  tick,
  graphOf,
  expectEverySaveWhole,
  membersOf,
  edgeIds,
  type Store,
} from "./workflow-group-mutations-test-support";

beforeEach(() => {
  vi.clearAllMocks();
});

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

  it("ungroups when the canvas deletion removes members", async () => {
    const { store } = groupedStore();
    const before = graphOf(store);

    boxSelect(store, ["a", "b"]);
    store.set(deleteCanvasSelectionAtom);
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
      config: undefined,
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

  it("pastes a Group clear of its original and ungroups the paste clear of every card", async () => {
    const { store, frameId } = groupedStore();
    store.set(selectOnlyNodeAtom, frameId);
    store.set(copySelectionAtom);
    const before = store.get(nodesAtom);

    store.set(pasteCopiedSelectionAtom);

    // The paste steps down and right from the original Group card, far enough
    // that the two collapsed cards no longer overlap.
    const pasted = store.get(nodesAtom);
    const pastedFrame = pasted.find(
      (node) => isGroupNode(node) && node.id !== frameId
    );
    if (!pastedFrame) {
      throw new Error("expected a pasted frame");
    }
    expect(overlappingCardIds(pasted)).toEqual([]);

    // The pasted Group connects to nothing outside it. Its released members
    // move together clear of the original Group card and the step below it,
    // and every node already on the canvas keeps its position.
    expect(store.set(ungroupNodeAtom, pastedFrame.id)).toBe(true);
    await tick();

    const released = store.get(nodesAtom);
    expect(overlappingCardIds(released)).toEqual([]);
    for (const node of before) {
      expect(released.find((item) => item.id === node.id)?.position).toEqual(
        node.position
      );
    }
    expectEverySaveWhole();
  });
});

describe("Authoring inside a focused Group", () => {
  const catalog = { entities: [], events: [], integrations: [], actions: [] };

  /** The grouped fixture with the Group entered, and the new frame's id. */
  function enteredStore(): { store: Store; frameId: string } {
    const grouped = groupedStore();
    showWorkspaceRoute(grouped.store, { group: grouped.frameId });
    return grouped;
  }

  function newStep(id: string): WorkflowNode {
    return {
      id,
      type: "action",
      position: { x: 900, y: 900 },
      data: { label: id, type: "action", config: {}, status: "idle" },
    };
  }

  it("adds a step as a member of the Group, selected, in one undo step", async () => {
    const { store, frameId } = enteredStore();
    const before = graphOf(store);

    expect(store.set(addNodeAtom, newStep("added"))).toEqual({
      inserted: true,
    });
    await tick();

    const added = store.get(nodesAtom).find((node) => node.id === "added");
    expect(added?.parentId).toBe(frameId);
    expect(added?.position).toEqual({ x: 900, y: 900 });
    expect(membersOf(store, frameId)).toEqual(["a", "b", "c", "added"]);
    expect(store.get(selectedNodeAtom)).toBe("added");
    expect(store.get(canvasNodesAtom).some((node) => node.id === "added")).toBe(
      true
    );
    expectEverySaveWhole();

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
    store.set(redoAtom);
    expect(membersOf(store, frameId)).toEqual(["a", "b", "c", "added"]);
  });

  it("adds a step after a member and connects it in the same undo step", () => {
    const { store, frameId } = enteredStore();
    const before = graphOf(store);

    const outcome = store.set(addConnectedNodeAtom, {
      node: newStep("after-a"),
      connection: {
        id: "a-after-a",
        source: "a",
        target: "after-a",
        sourceHandle: null,
        targetHandle: null,
      },
      throughBoundaryStub: false,
      catalog,
    });

    expect(outcome).toEqual({ inserted: true });
    expect(membersOf(store, frameId)).toContain("after-a");
    expect(
      store.get(edgesAtom).find((item) => item.id === "a-after-a")
    ).toMatchObject({ source: "a", target: "after-a" });
    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
  });

  it("opens a member row and reprojects its continuation stub", () => {
    const rowHeight = WORKFLOW_NODE_HEIGHT + RANK_SPACING;
    const store = createGraphStore({
      nodes: [
        lifecycle(),
        {
          id: "g",
          type: "group",
          position: { x: 0, y: 200 },
          data: { label: "Group", type: "group" },
        },
        { ...lookup("a"), parentId: "g", position: { x: 0, y: 0 } },
        { ...lookup("b"), parentId: "g", position: { x: 0, y: rowHeight } },
        { ...lookup("after"), position: { x: 0, y: 600 } },
      ],
      edges: [
        edge("life-a", "life", "a", "started"),
        edge("a-b", "a", "b"),
        edge("b-after", "b", "after"),
      ],
    });
    showWorkspaceRoute(store, { group: "g" });
    const continuationId = boundaryStubId("continuation", {
      nodeId: "after",
      handle: null,
    });
    const continuationBefore = store
      .get(canvasNodesAtom)
      .find((node) => node.id === continuationId)?.position;
    const before = graphOf(store);

    expect(
      store.set(insertStepOnEdgeAtom, {
        node: newStep("between"),
        edgeId: "a-b",
        catalog,
      })
    ).toEqual({ inserted: true });

    const nodes = store.get(nodesAtom);
    expect(nodes.find((node) => node.id === "between")).toMatchObject({
      parentId: "g",
      position: { x: 0, y: rowHeight },
    });
    expect(nodes.find((node) => node.id === "b")?.position).toEqual({
      x: 0,
      y: rowHeight * 2,
    });
    expect(nodes.find((node) => node.id === "after")?.position).toEqual({
      x: 0,
      y: 600,
    });
    expect(
      store.get(canvasNodesAtom).find((node) => node.id === continuationId)
        ?.position.y
    ).toBe((continuationBefore?.y ?? 0) + rowHeight);

    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
  });

  it("pastes and duplicates a copied member as a member of the Group", async () => {
    const { store, frameId } = enteredStore();
    store.set(selectOnlyNodeAtom, "a");
    store.set(copySelectionAtom);

    expect(store.set(pasteCopiedSelectionAtom)).toEqual({ inserted: true });
    const pasted = store.get(selectedNodeAtom);
    expect(membersOf(store, frameId)).toEqual(["a", "b", "c", pasted]);
    expect(
      store.get(nodesAtom).filter((node) => isGroupNode(node))
    ).toHaveLength(1);

    store.set(selectOnlyNodeAtom, "b");
    expect(store.set(duplicateSelectionAtom)).toEqual({ inserted: true });
    const duplicated = store.get(selectedNodeAtom);
    expect(membersOf(store, frameId)).toEqual([
      "a",
      "b",
      "c",
      pasted,
      duplicated,
    ]);
    await tick();
    expectEverySaveWhole();
  });

  it.each(["paste", "duplicate"] as const)(
    "places a focused %s clear of local members, regardless of the frame position",
    (mode) => {
      const { store, frameId } = enteredStore();
      store.set(
        nodesStateAtom,
        store.get(nodesStateAtom).map((node) => ({
          ...node,
          position:
            node.id === frameId
              ? { x: 5000, y: 5000 }
              : node.id === "a"
                ? { x: 0, y: 0 }
                : node.id === "b"
                  ? { x: 48, y: 48 }
                  : node.position,
        }))
      );
      store.set(selectOnlyNodeAtom, "a");
      store.set(copySelectionAtom);
      expect(
        mode === "paste"
          ? store.set(pasteCopiedSelectionAtom)
          : store.set(duplicateSelectionAtom)
      ).toEqual({ inserted: true });
      const insertedId = store.get(selectedNodeAtom);
      expect(
        overlappingCardIds(store.get(canvasNodesAtom)).filter((pair) =>
          pair.includes(insertedId!)
        )
      ).toEqual([]);
    }
  );

  it.each([false, true])(
    "inserts before a diamond join atomically (focused Group: %s)",
    (focused) => {
      const store = createGraphStore({
        nodes: [
          lifecycle(),
          {
            id: "g",
            type: "group",
            position: { x: 0, y: 200 },
            data: { label: "Group", type: "group" },
          },
          ...["a", "b", "c", "join"].map((id) =>
            focused ? { ...lookup(id), parentId: "g" } : lookup(id)
          ),
        ],
        edges: [
          edge("la", "life", "a", "started"),
          edge("ab", "a", "b"),
          edge("ac", "a", "c"),
          edge("bj", "b", "join"),
          edge("cj", "c", "join"),
        ],
      });
      if (focused) showWorkspaceRoute(store, { group: "g" });
      const before = graphOf(store);
      expect(
        store.set(addStepAfterAtom, {
          node: newStep("inserted"),
          source: { nodeId: "a", handle: null },
          catalog,
        })
      ).toEqual({ inserted: true });
      expect(
        store
          .get(edgesAtom)
          .map((item) => `${item.source}>${item.target}`)
          .toSorted()
      ).toEqual([
        "a>inserted",
        "b>join",
        "c>join",
        "inserted>b",
        "inserted>c",
        "life>a",
      ]);
      store.set(undoAtom);
      expect(graphOf(store)).toEqual(before);
      expect(
        store.set(insertStepOnEdgeAtom, {
          node: newStep("inserted"),
          edgeId: "ab",
          catalog,
        })
      ).toEqual({ inserted: true });
      expect(
        store
          .get(edgesAtom)
          .map((item) => `${item.source}>${item.target}`)
          .toSorted()
      ).toEqual([
        "a>c",
        "a>inserted",
        "b>join",
        "c>join",
        "inserted>b",
        "life>a",
      ]);
    }
  );

  it("preserves existing ports and chooses one default outlet for the inserted node", () => {
    const store = createGraphStore({
      nodes: [lifecycle(), lookup("a"), lookup("b"), lookup("c")],
      edges: [
        edge("la", "life", "a", "started"),
        { ...edge("ab", "a", "b"), targetHandle: "input-b" },
        { ...edge("ac", "a", "c"), targetHandle: "input-c" },
      ],
    });
    const node = newStep("inserted");
    node.data.config = { actionType: BUILT_IN_ACTION_IDS.condition };
    expect(
      store.set(addStepAfterAtom, {
        node,
        source: { nodeId: "a", handle: null },
        catalog,
      })
    ).toEqual({ inserted: true });
    expect(
      store
        .get(edgesAtom)
        .filter((item) => item.source === "inserted")
        .map((item) => [item.sourceHandle, item.target, item.targetHandle])
    ).toEqual([
      ["true", "b", "input-b"],
      ["true", "c", "input-c"],
    ]);
    expect(
      store.get(edgesAtom).find((item) => item.source === "a")
    ).toMatchObject({ sourceHandle: null, target: "inserted" });
  });

  it("refuses a replacement into Lifecycle without writing history or saving", async () => {
    const store = createGraphStore({
      nodes: [lifecycle(), lookup("a")],
      edges: [edge("la", "life", "a", "started")],
    });
    const before = graphOf(store);
    const history = store.get(historyAtom);
    const node = { ...lifecycle(), id: "invalid" };
    expect(
      store.set(insertStepOnEdgeAtom, { node, edgeId: "la", catalog })
    ).toEqual({
      refusal:
        "Lifecycle is the workflow entry and cannot accept a connection.",
    });
    await tick();
    expect(graphOf(store)).toEqual(before);
    expect(store.get(historyAtom)).toBe(history);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("refuses to paste a copied Group inside a Group and changes nothing", () => {
    const { store, frameId } = groupedStore();
    store.set(selectOnlyNodeAtom, frameId);
    store.set(copySelectionAtom);
    showWorkspaceRoute(store, { group: frameId });
    const before = graphOf(store);
    const history = store.get(historyAtom);

    expect(store.set(pasteCopiedSelectionAtom)).toEqual({
      refusal: 'Group "Group" cannot sit inside another Group',
    });
    expect(graphOf(store)).toEqual(before);
    expect(store.get(historyAtom)).toBe(history);
  });

  it("refuses a step whose connection the planner refuses, adding neither", () => {
    const { store } = enteredStore();
    const before = graphOf(store);

    // A drag onto the "Continues to after" stub from a new member that nothing
    // reaches would join `after` from an unreachable branch.
    const outcome = store.set(addConnectedNodeAtom, {
      node: newStep("orphan"),
      connection: {
        id: "orphan-after",
        source: "orphan",
        target: "after",
        sourceHandle: null,
        targetHandle: null,
      },
      throughBoundaryStub: true,
      catalog,
    });

    expect(outcome).toEqual({
      refusal:
        'Node "after" cannot join an unreachable branch (found "orphan")',
    });
    expect(graphOf(store)).toEqual(before);
  });

  describe("adding steps after two members that continue to one outside step", () => {
    // The reported Group: Get User and Find Issues, both entered from the
    // Lifecycle, both continuing to one outside Action.
    function continuingStore(): Store {
      const store = createGraphStore({
        nodes: [
          lifecycle(),
          {
            id: "g",
            type: "group",
            position: { x: 0, y: 200 },
            data: { label: "Lookups", type: "group" },
          },
          { ...lookup("getUser"), parentId: "g" },
          { ...lookup("findIssues"), parentId: "g" },
          { ...lookup("next"), position: { x: 0, y: 600 } },
        ],
        edges: [
          edge("start-get", "life", "getUser", "started"),
          edge("start-find", "life", "findIssues", "started"),
          edge("get-next", "getUser", "next"),
          edge("find-next", "findIssues", "next"),
        ],
      });
      showWorkspaceRoute(store, { group: "g" });
      vi.clearAllMocks();
      return store;
    }

    const addAfter = (store: Store, source: string, id: string) =>
      store.set(addStepAfterAtom, {
        node: newStep(id),
        source: { nodeId: source, handle: null },
        catalog,
      });

    const links = (store: Store) =>
      store
        .get(edgesAtom)
        .map((item) => `${item.source}>${item.target}`)
        .toSorted();

    it("inserts the step before the outlet's next step in one undo step", async () => {
      const store = continuingStore();
      const before = graphOf(store);

      expect(addAfter(store, "getUser", "first")).toEqual({ inserted: true });
      expect(links(store)).toEqual([
        "findIssues>next",
        "first>next",
        "getUser>first",
        "life>findIssues",
        "life>getUser",
      ]);
      expect(membersOf(store, "g")).toContain("first");
      await tick();
      expectEverySaveWhole();

      store.set(undoAtom);
      expect(graphOf(store)).toEqual(before);
    });

    it("keeps one exit and no path ends when a step is added after each member", () => {
      const store = continuingStore();
      addAfter(store, "getUser", "first");
      addAfter(store, "findIssues", "second");

      const painted = store.get(canvasNodesAtom);
      expect(
        painted
          .filter((node) => node.type === "groupEnd")
          .map((node) => node.id)
      ).toEqual([]);
      expect(
        painted.filter((node) => node.type === "groupContinuation")
      ).toHaveLength(1);
    });

    it("puts a step inside a member's connection to the outside step", () => {
      const store = continuingStore();
      const continuation = store
        .get(canvasEdgesAtom)
        .find((item) => item.id === "get-next");

      expect(
        store.set(insertStepOnEdgeAtom, {
          node: newStep("between"),
          edgeId: continuation?.id ?? "",
          catalog,
        })
      ).toEqual({ inserted: true });
      expect(links(store)).toEqual([
        "between>next",
        "findIssues>next",
        "getUser>between",
        "life>findIssues",
        "life>getUser",
      ]);
      expect(membersOf(store, "g")).toContain("between");
    });
  });

  describe("on the overview", () => {
    it.each(["after", "edge"] as const)(
      "preserves exactly the continuing outlet when inserting %s on a collapsed Group",
      (mode) => {
        const store = createGraphStore({
          nodes: [
            lifecycle(),
            {
              id: "g",
              type: "group",
              position: { x: 0, y: 200 },
              data: { label: "Group", type: "group" },
            },
            { ...lookup("a"), parentId: "g" },
            { ...lookup("b"), parentId: "g" },
            lookup("next"),
          ],
          edges: [
            edge("la", "life", "a", "started"),
            edge("lb", "life", "b", "started"),
            edge("an", "a", "next"),
          ],
        });
        const outcome =
          mode === "after"
            ? store.set(addStepAfterAtom, {
                node: newStep("inserted"),
                source: { nodeId: "g", handle: null },
                catalog,
              })
            : store.set(insertStepOnEdgeAtom, {
                node: newStep("inserted"),
                edgeId: "an",
                catalog,
              });
        expect(outcome).toEqual({ inserted: true });
        expect(
          store
            .get(edgesAtom)
            .map((item) => `${item.source}>${item.target}`)
            .toSorted()
        ).toEqual(["a>inserted", "inserted>next", "life>a", "life>b"]);
      }
    );
    function overviewStore(): Store {
      const store = createGraphStore({
        nodes: [
          lifecycle(),
          lookup("a"),
          { ...lookup("b"), position: { x: 0, y: 400 } },
        ],
        edges: [edge("start-a", "life", "a", "started"), edge("a-b", "a", "b")],
      });
      vi.clearAllMocks();
      return store;
    }

    const links = (store: Store) =>
      store
        .get(edgesAtom)
        .map((item) => `${item.source}>${item.target}`)
        .toSorted();

    it("inserts a step before what the outlet already reaches", () => {
      const store = overviewStore();

      expect(
        store.set(addStepAfterAtom, {
          node: newStep("beside"),
          source: { nodeId: "a", handle: null },
          catalog,
        })
      ).toEqual({ inserted: true });
      expect(links(store)).toEqual(["a>beside", "beside>b", "life>a"]);
      expect(store.get(selectedNodeAtom)).toBe("beside");
    });

    it("adds only one edge when dragging an occupied outlet into empty canvas", () => {
      const store = overviewStore();
      expect(
        store.set(addConnectedNodeAtom, {
          node: newStep("branch"),
          connection: { id: "a-branch", source: "a", target: "branch" },
          throughBoundaryStub: false,
          catalog,
        })
      ).toEqual({ inserted: true });
      expect(links(store)).toEqual(["a>b", "a>branch", "life>a"]);
    });

    it("puts a step inside a connection", () => {
      const store = overviewStore();

      expect(
        store.set(insertStepOnEdgeAtom, {
          node: newStep("between"),
          edgeId: "a-b",
          catalog,
        })
      ).toEqual({ inserted: true });
      expect(links(store)).toEqual(["a>between", "between>b", "life>a"]);

      store.set(undoAtom);
      expect(links(store)).toEqual(["a>b", "life>a"]);
    });

    it("opens space only in the target branch", () => {
      const targetY = 400;
      const rowHeight = WORKFLOW_NODE_HEIGHT + RANK_SPACING;
      const store = createGraphStore({
        nodes: [
          lifecycle(),
          lookup("a"),
          { ...lookup("b", 120), position: { x: 120, y: targetY } },
          { ...lookup("peer", -220), position: { x: -220, y: targetY } },
          { ...lookup("child", 120), position: { x: 120, y: 600 } },
          { ...lookup("lower", -220), position: { x: -220, y: 600 } },
        ],
        edges: [
          edge("start-a", "life", "a", "started"),
          edge("a-b", "a", "b"),
          edge("a-peer", "a", "peer"),
          edge("b-child", "b", "child"),
        ],
      });
      const before = graphOf(store);

      expect(
        store.set(insertStepOnEdgeAtom, {
          node: newStep("between"),
          edgeId: "a-b",
          catalog,
        })
      ).toEqual({ inserted: true });

      const positions = new Map(
        store.get(nodesAtom).map((node) => [node.id, node.position])
      );
      expect(positions.get("a")).toEqual({ x: 0, y: 200 });
      expect(positions.get("between")).toEqual({ x: 120, y: targetY });
      expect(positions.get("b")).toEqual({ x: 120, y: targetY + rowHeight });
      expect(positions.get("child")).toEqual({
        x: 120,
        y: 600 + rowHeight,
      });
      expect(positions.get("peer")).toEqual({ x: -220, y: targetY });
      expect(positions.get("lower")).toEqual({ x: -220, y: 600 });

      store.set(undoAtom);
      expect(graphOf(store)).toEqual(before);
    });

    it("inserts after an Incoming from stub without leaving a parallel ingress", () => {
      const store = createGraphStore({
        nodes: [
          lifecycle(),
          {
            id: "g",
            type: "group",
            position: { x: 0, y: 200 },
            data: { label: "Lookups", type: "group" },
          },
          { ...lookup("a"), parentId: "g" },
          { ...lookup("b"), parentId: "g" },
        ],
        edges: [edge("start-a", "life", "a", "started"), edge("a-b", "a", "b")],
      });
      showWorkspaceRoute(store, { group: "g" });
      vi.clearAllMocks();

      const outcome = store.set(addStepAfterAtom, {
        node: newStep("beside"),
        source: {
          nodeId: boundaryStubId("ingress", {
            nodeId: "life",
            handle: "started",
          }),
          handle: null,
        },
        catalog,
      });

      expect(outcome).toEqual({ inserted: true });
      expect(
        store
          .get(edgesAtom)
          .map((item) => `${item.source}>${item.target}`)
          .toSorted()
      ).toEqual(["a>b", "beside>a", "life>beside"]);
    });
  });
});
