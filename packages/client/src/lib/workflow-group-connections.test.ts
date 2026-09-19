import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { groupContractViolations } from "@wfgraph/shared/graph/group-contract";
import { workflowTopologyRefusalReason } from "@wfgraph/shared/graph/workflow-topology";
import {
  connectionRefusalReason,
  planConnection,
} from "#src/components/workflow/connection-validation";
import {
  boundaryStubId,
  storedCanvasConnection,
} from "#src/lib/group-scope-canvas";
import {
  addStepAfterAtom,
  canvasEdgesAtom,
  canvasNodesAtom,
  connectNodesAtom,
  deleteSelectedItemsAtom,
  edgesAtom,
  groupSelectionAtom,
  nodesAtom,
  deleteEdgeAtom,
  redoAtom,
  undoAtom,
} from "#src/lib/workflow-graph-store";
import {
  toPersistedEdge,
  toPersistedNodes,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { historyAtom } from "#src/lib/workflow-graph-cells";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import {
  updateMock,
  lifecycle,
  lookup,
  condition,
  edge,
  createGraphStore,
  tick,
  graphOf,
  expectEverySaveWhole,
  edgeIds,
  lastSaved,
  type Store,
  type Graph,
} from "./workflow-group-mutations-test-support";

beforeEach(() => {
  vi.clearAllMocks();
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

describe("continuing a Group with an unused Condition outlet", () => {
  it.each([
    { operation: "connect", branch: "true" },
    { operation: "add after", branch: "true" },
    { operation: "connect", branch: "false" },
    { operation: "add after", branch: "false" },
  ])(
    "$operation continues only from the wired $branch branch's last step",
    async ({ operation, branch }) => {
      const after = lookup("after");
      const store = createGraphStore({
        nodes: [
          lifecycle(),
          lookup("get"),
          condition("gate"),
          lookup("create"),
          ...(operation === "connect" ? [after] : []),
        ],
        edges: [
          edge("start", "life", "get", "started"),
          edge("check", "get", "gate"),
          edge("create", "gate", "create", branch),
        ],
      });
      store.set(groupSelectionAtom, {
        selectedIds: new Set(["get", "gate", "create"]),
      });
      const frameId = store.get(nodesAtom).find(isGroupNode)!.id;
      await tick();
      vi.clearAllMocks();
      const before = graphOf(store);
      const connection = { id: "next", source: frameId, target: "after" };
      expect(
        connectionRefusalReason({
          nodes:
            operation === "connect" ? before.nodes : [...before.nodes, after],
          storeEdges: before.edges,
          connection,
          catalog: emptyExtensionCatalog,
        })
      ).toBeNull();
      const outcome =
        operation === "connect"
          ? store.set(connectNodesAtom, {
              connection,
              catalog: emptyExtensionCatalog,
            })
          : store.set(addStepAfterAtom, {
              node: after,
              source: { nodeId: frameId, handle: null },
              catalog: emptyExtensionCatalog,
            });
      expect(outcome).not.toHaveProperty("refusal");
      await tick();
      const continued = graphOf(store);
      expect(
        continued.edges.filter((item) => item.target === "after")
      ).toMatchObject([{ source: "create", target: "after" }]);
      expect(continued.edges.filter((item) => item.source === "gate")).toEqual([
        edge("create", "gate", "create", branch),
      ]);
      expect(groupContractViolations(continued)).toEqual([]);
      expect(lastSaved().edges).toEqual(continued.edges);
      expectEverySaveWhole();
      store.set(undoAtom);
      expect(graphOf(store)).toEqual(before);
      store.set(redoAtom);
      expect(graphOf(store)).toEqual(continued);
    }
  );
});

describe("a Group with no connected branch to continue", () => {
  it("asks for a branch without changing the graph, but permits an explicit branch connection", async () => {
    const store = createGraphStore({
      nodes: [lifecycle(), lookup("get"), condition("gate"), lookup("after")],
      edges: [
        edge("start", "life", "get", "started"),
        edge("check", "get", "gate"),
      ],
    });
    store.set(groupSelectionAtom, { selectedIds: new Set(["get", "gate"]) });
    const frameId = store.get(nodesAtom).find(isGroupNode)!.id;
    await tick();
    vi.clearAllMocks();
    const before = graphOf(store);
    const history = store.get(historyAtom);
    expect(
      store.set(connectNodesAtom, {
        connection: { id: "next", source: frameId, target: "after" },
        catalog: emptyExtensionCatalog,
      })
    ).toEqual({
      refusal: "Open this Group and connect the branch you want to continue.",
    });
    await tick();
    expect(graphOf(store)).toEqual(before);
    expect(store.get(historyAtom)).toBe(history);
    expect(updateMock).not.toHaveBeenCalled();
    expect(
      planConnection({
        nodes: before.nodes,
        storeEdges: before.edges,
        connection: { source: "gate", sourceHandle: "false", target: "after" },
        throughBoundaryStub: true,
        catalog: emptyExtensionCatalog,
      })
    ).toEqual({
      additions: [{ source: "gate", sourceHandle: "false", target: "after" }],
    });
  });
});

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

    store.set(deleteEdgeAtom, "qualify-read");
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
    store.set(deleteEdgeAtom, "qualify-profile");
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
      throughBoundaryStub: translated.throughBoundaryStub,
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
  it("refuses a cycle inside a focused Group before saving or recording history", async () => {
    const store = createGraphStore({
      nodes: [lifecycle(), lookup("read"), lookup("send")],
      edges: [edge("read-send", "read", "send")],
    });
    store.set(groupSelectionAtom, { selectedIds: new Set(["read", "send"]) });
    const frameId = store.get(nodesAtom).find(isGroupNode)!.id;
    showWorkspaceRoute(store, { group: frameId });
    await tick();
    vi.clearAllMocks();
    const grouped = graphOf(store);
    const history = store.get(historyAtom);
    const connection = { source: "send", target: "read" };
    const refusal =
      "This connection would create a cycle. Connect to a step that does not lead back here.";

    expect(
      connectionRefusalReason({
        connection,
        nodes: store.get(nodesAtom),
        storeEdges: store.get(edgesAtom),
        catalog: emptyExtensionCatalog,
      })
    ).toBe(refusal);
    expect(
      store.set(connectNodesAtom, {
        connection: { id: "cycle", ...connection },
        catalog: emptyExtensionCatalog,
      })
    ).toEqual({ refusal });
    await tick();
    expect(graphOf(store)).toEqual(grouped);
    expect(store.get(historyAtom)).toBe(history);
    expect(updateMock).not.toHaveBeenCalled();
    expect(
      workflowTopologyRefusalReason({
        nodes: toPersistedNodes(store.get(nodesAtom)),
        edges: store.get(edgesAtom).map(toPersistedEdge),
      })
    ).toBeNull();
  });

  it("stores exactly the additions the preview planned against the same graph", async () => {
    const { store, frameId } = groupedFanOut();
    store.set(deleteEdgeAtom, "qualify-read");
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
    for (const member of store.get(nodesAtom).filter((node) => node.parentId)) {
      expect(
        store.get(canvasNodesAtom).find((node) => node.id === member.id)
          ?.position
      ).toEqual(member.position);
    }
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
        throughBoundaryStub: true,
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
