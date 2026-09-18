import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { groupContractViolations } from "@wfgraph/shared/graph/group-contract";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  connectNodesAtom,
  edgesAtom,
  groupSelectionAtom,
  nodesAtom,
  onEdgesChangeAtom,
  redoAtom,
  setGroupDirectionAtom,
  snapshotHistoryAtom,
  undoAtom,
  ungroupNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  toPersistedEdge,
  toPersistedNodes,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { historyAtom, nodesStateAtom } from "#src/lib/workflow-graph-cells";
import {
  activeWorkspaceAddressAtom,
  activeWorkspaceCamerasAtom,
  recordWorkspaceCameraAtom,
} from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import {
  updateMock,
  lifecycle,
  edge,
  createGraphStore,
  tick,
  graphOf,
  expectEverySaveWhole,
  membersOf,
  edgeIds,
  lastSaved,
  type Graph,
} from "./workflow-group-mutations-test-support";

beforeEach(() => {
  vi.clearAllMocks();
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

  it("fits a Group's focused desktop canvas again after its direction flips, and after the flip is undone, keeping the phone's top-to-bottom camera", () => {
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
      mobile: camera,
    });

    enterAndLook();
    showWorkspaceRoute(store, {});
    store.set(undoAtom);
    showWorkspaceRoute(store, { group: groupId });
    expect(store.get(activeWorkspaceCamerasAtom)).toEqual({
      desktop: null,
      mobile: camera,
    });

    enterAndLook();
    showWorkspaceRoute(store, {});
    store.set(redoAtom);
    showWorkspaceRoute(store, { group: groupId });
    expect(store.get(activeWorkspaceCamerasAtom)).toEqual({
      desktop: null,
      mobile: camera,
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
