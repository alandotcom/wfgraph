import { describe, expect, it, vi } from "vitest";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import {
  GROUP_REGION_INSET,
  groupRegionBox,
} from "@wfgraph/shared/graph/workflow-layout-geometry";
import { layoutWorkflowNodes } from "#src/components/workflow/workflow-layout";
import {
  applyNodeLayoutAtom,
  canvasGraphAtom,
  groupSelectionAtom,
  nodesAtom,
  onNodesChangeAtom,
  undoAtom,
  redoAtom,
  ungroupNodeAtom,
} from "#src/lib/workflow-graph-store";
import { historyAtom } from "#src/lib/workflow-graph-cells";
import {
  createGraphStore,
  ungroupedGraph,
  graphOf,
  tick,
  expectEverySaveWhole,
  updateMock,
} from "./workflow-group-mutations-test-support";

async function groupedStore() {
  const store = createGraphStore(ungroupedGraph());
  store.set(groupSelectionAtom, { selectedIds: new Set(["a", "b", "c"]) });
  const frame = store.get(nodesAtom).find(isGroupNode);
  if (!frame) throw new Error("expected Group");
  await tick();
  vi.clearAllMocks();
  return { store, frame };
}

describe("stored Group layout", () => {
  it("paints each member at its stored position inside a region sized to them, writing nothing", async () => {
    const { store, frame } = await groupedStore();
    const before = graphOf(store);
    const history = store.get(historyAtom);
    const canvas = store.get(canvasGraphAtom);
    const members = before.nodes.filter((node) => node.parentId === frame.id);
    for (const member of members) {
      expect(canvas.nodes.find((node) => node.id === member.id)).toMatchObject({
        position: member.position,
        parentId: frame.id,
        extent: "parent",
      });
    }
    expect(canvas.nodes.find((node) => node.id === frame.id)).toMatchObject({
      position: frame.position,
      ...groupRegionBox(members),
    });
    await tick();
    expect(graphOf(store)).toEqual(before);
    expect(store.get(historyAtom)).toBe(history);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("saves a drag of one member as one undo step, without moving siblings or its frame", async () => {
    const { store } = await groupedStore();
    const before = graphOf(store);
    const history = store.get(historyAtom).length;
    for (const [x, dragging] of [
      [500, true],
      [560, true],
      [560, false],
    ] as const) {
      store.set(onNodesChangeAtom, [
        { id: "a", type: "position", position: { x, y: 720 }, dragging },
      ]);
    }
    await tick();
    expect(store.get(historyAtom)).toHaveLength(history + 1);
    expect(
      store.get(nodesAtom).find((node) => node.id === "a")?.position
    ).toEqual({ x: 560, y: 720 });
    for (const node of before.nodes.filter((item) => item.id !== "a")) {
      expect(store.get(nodesAtom).find((item) => item.id === node.id)).toEqual(
        node
      );
    }
    expectEverySaveWhole();
    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
    store.set(redoAtom);
    expect(
      store.get(nodesAtom).find((node) => node.id === "a")?.position
    ).toEqual({ x: 560, y: 720 });
  });

  it("Tidies each Group's members inside its region and the graph around it in one undo step", async () => {
    const { store, frame } = await groupedStore();
    const before = graphOf(store);
    const result = layoutWorkflowNodes({
      nodes: store.get(nodesAtom),
      edges: graphOf(store).edges,
      catalog: emptyExtensionCatalog,
    });
    store.set(applyNodeLayoutAtom, result.nodes);
    await tick();
    const after = graphOf(store);
    expect(after.edges).toBe(before.edges);
    const members = after.nodes.filter((node) => node.parentId === frame.id);
    // Members start at the region's corner and stay inside it.
    expect(Math.min(...members.map((node) => node.position.x))).toBe(0);
    expect(Math.min(...members.map((node) => node.position.y))).toBe(0);
    const laidFrame = after.nodes.find((node) => node.id === frame.id);
    expect(laidFrame).toMatchObject(groupRegionBox(members));
    // No step outside the Group overlaps the region's outline.
    const outline = {
      left: (laidFrame?.position.x ?? 0) - GROUP_REGION_INSET.left,
      top: (laidFrame?.position.y ?? 0) - GROUP_REGION_INSET.top,
      right: (laidFrame?.position.x ?? 0) + (laidFrame?.width ?? 0),
      bottom: (laidFrame?.position.y ?? 0) + (laidFrame?.height ?? 0),
    };
    for (const node of after.nodes.filter(
      (item) => item.parentId === undefined && item.id !== frame.id
    )) {
      const right = node.position.x + (node.width ?? 192);
      const bottom = node.position.y + (node.height ?? 112);
      const overlaps =
        node.position.x < outline.right &&
        right > outline.left &&
        node.position.y < outline.bottom &&
        bottom > outline.top;
      expect(overlaps).toBe(false);
    }
    expectEverySaveWhole();
    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
  });

  it("ungroups without changing the relative arrangement a person dragged", async () => {
    const { store, frame } = await groupedStore();
    store.set(onNodesChangeAtom, [
      {
        id: "a",
        type: "position",
        position: { x: -360, y: 700 },
        dragging: true,
      },
    ]);
    store.set(onNodesChangeAtom, [
      {
        id: "a",
        type: "position",
        position: { x: -360, y: 700 },
        dragging: false,
      },
    ]);
    const before = graphOf(store);
    store.set(ungroupNodeAtom, frame.id);
    const after = graphOf(store);
    const delta = (id: string) => {
      const original = before.nodes.find((node) => node.id === id)!;
      const released = after.nodes.find((node) => node.id === id)!;
      expect(released.parentId).toBeUndefined();
      return {
        x: released.position.x - original.position.x,
        y: released.position.y - original.position.y,
      };
    };
    expect(delta("a")).toEqual(delta("b"));
    expect(delta("b")).toEqual(delta("c"));
    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
  });
});
