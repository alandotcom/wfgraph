import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { RANK_SPACING } from "@wfgraph/shared/graph/workflow-layout-geometry";
import {
  GROUP_BOUNDARY_NODE_TYPES,
  GROUP_BOUNDARY_STUB_HEIGHT,
} from "#src/lib/group-scope-canvas";
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
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import {
  createGraphStore,
  ungroupedGraph,
  graphOf,
  tick,
  expectEverySaveWhole,
  updateMock,
} from "./workflow-group-mutations-test-support";

beforeEach(() => vi.clearAllMocks());
async function focusedStore() {
  const store = createGraphStore(ungroupedGraph());
  store.set(groupSelectionAtom, { selectedIds: new Set(["a", "b", "c"]) });
  const frame = store.get(nodesAtom).find(isGroupNode);
  if (!frame) throw new Error("expected Group");
  showWorkspaceRoute(store, { group: frame.id });
  await tick();
  vi.clearAllMocks();
  return { store, frame };
}

describe("stored Group layout", () => {
  it("entering, painting and leaving a Group writes no coordinates or history", async () => {
    const { store } = await focusedStore();
    const before = graphOf(store);
    const history = store.get(historyAtom);
    const canvas = store.get(canvasGraphAtom);
    for (const member of before.nodes.filter((node) => node.parentId)) {
      expect(
        canvas.nodes.find((node) => node.id === member.id)?.position
      ).toEqual(member.position);
    }
    showWorkspaceRoute(store, {});
    await tick();
    expect(graphOf(store)).toEqual(before);
    expect(store.get(historyAtom)).toBe(history);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("saves a drag of one member as one undo step, without moving siblings or its frame", async () => {
    const { store } = await focusedStore();
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

  it("Tidies members with stubs, persisting only member coordinates in one undo step", async () => {
    const { store, frame } = await focusedStore();
    const before = graphOf(store);
    const painted = store.get(canvasGraphAtom);
    const result = layoutWorkflowNodes({
      ...painted,
      catalog: emptyExtensionCatalog,
    });
    const ingress = result.nodes.find(
      (node) => node.type === GROUP_BOUNDARY_NODE_TYPES.ingress
    )!;
    const firstMember = result.nodes.find((node) => node.id === "a")!;
    expect(firstMember.position.y - ingress.position.y).toBe(
      GROUP_BOUNDARY_STUB_HEIGHT + RANK_SPACING
    );
    store.set(applyNodeLayoutAtom, result.nodes);
    await tick();
    const after = graphOf(store);
    expect(after.edges).toBe(before.edges);
    expect(after.nodes.map((node) => node.id)).toEqual(
      before.nodes.map((node) => node.id)
    );
    for (const node of before.nodes) {
      const updated = after.nodes.find((item) => item.id === node.id);
      if (node.parentId === frame.id) {
        expect(updated).toEqual({
          ...node,
          position: result.nodes.find((item) => item.id === node.id)?.position,
        });
      } else expect(updated).toBe(node);
    }
    expectEverySaveWhole();
    store.set(undoAtom);
    expect(graphOf(store)).toEqual(before);
  });

  it("does not save or add history when another Tidy moves only derived stubs", async () => {
    const { store } = await focusedStore();
    const tidy = () =>
      store.set(
        applyNodeLayoutAtom,
        layoutWorkflowNodes({
          ...store.get(canvasGraphAtom),
          catalog: emptyExtensionCatalog,
        }).nodes
      );
    tidy();
    await tick();
    const before = graphOf(store);
    const history = store.get(historyAtom);
    vi.clearAllMocks();
    tidy();
    expect(graphOf(store).nodes).toEqual(before.nodes);
    tidy();
    await tick();
    expect(graphOf(store).nodes).toBe(before.nodes);
    expect(store.get(historyAtom)).toBe(history);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("ungroups without changing the relative arrangement a person dragged", async () => {
    const { store, frame } = await focusedStore();
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
