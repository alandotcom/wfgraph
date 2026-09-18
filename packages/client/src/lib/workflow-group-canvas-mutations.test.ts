import { beforeEach, describe, expect, it, vi } from "vitest";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { overlappingCardIds } from "@wfgraph/shared/graph/node-placement-test-support";
import {
  copySelectionAtom,
  deleteEdgeAtom,
  deleteGroupWithMembersAtom,
  deleteNodeAtom,
  deleteSelectedItemsAtom,
  edgesAtom,
  groupSelectionAtom,
  nodesAtom,
  onNodesChangeAtom,
  pasteCopiedSelectionAtom,
  redoAtom,
  selectedNodeAtom,
  selectOnlyNodeAtom,
  snapshotHistoryAtom,
  undoAtom,
  ungroupNodeAtom,
} from "#src/lib/workflow-graph-store";
import { nodesStateAtom } from "#src/lib/workflow-graph-cells";
import {
  updateMock,
  ungroupedGraph,
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
