import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  NODE_SPACING,
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import {
  canUngroup,
  groupSelection,
  removeGroupWithMembers,
  removeNodes,
  repairCanvasGroups,
  ungroupNode,
} from "#src/lib/node-group";
import {
  fanOutStoreEdges,
  orderGroupParentsFirst,
  undersizedGroupIds,
} from "@wfgraph/shared/graph/node-group";
import { groupStructureRefusalReason } from "@wfgraph/shared/graph/group-structure";
import {
  toPersistedEdge,
  toPersistedNodes,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

function action(
  id: string,
  actionType: string,
  position: { x: number; y: number }
): WorkflowNode {
  return {
    id,
    type: "action",
    position,
    data: {
      label: id,
      type: "action",
      config: { actionType },
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

/**
 * Two lookups running side by side into one Condition, reached from the
 * Lifecycle Node. Grouping this gives a frame two columns wide and two rows
 * deep, which is the shape both the nesting and the ungrouping are read from.
 */
function parallelNodes(): WorkflowNode[] {
  return [
    {
      ...action("life", "ignored", { x: 0, y: 0 }),
      type: "lifecycle",
      data: { label: "Start", type: "lifecycle", config: {} },
    },
    action("a", "fountain/get-user", { x: 40, y: 200 }),
    action("b", "fountain/get-appointment", { x: 240, y: 200 }),
    action("c", BUILT_IN_ACTION_IDS.condition, { x: 140, y: 400 }),
  ];
}

function parallelEdges(): WorkflowEdge[] {
  return [
    edge("in-a", "life", "a", "started"),
    edge("in-b", "life", "b", "started"),
    edge("a-c", "a", "c"),
    edge("b-c", "b", "c"),
  ];
}

/** A frame plus its members, as the store holds them after a group. */
function framedNodes(): WorkflowNode[] {
  const grouped = groupSelection({
    nodes: parallelNodes(),
    edges: parallelEdges(),
    selectedIds: new Set(["a", "b", "c"]),
    createId: () => "g1",
  });
  if (!grouped) {
    throw new Error("expected the parallel fixture to group");
  }
  return grouped.nodes;
}

describe("groupSelection", () => {
  // `displayNodesAtom` hands its answer back untouched only while the nodes
  // already read rest, then frames, then members. Appending the new frame after
  // the members of an existing one breaks that order, and every canvas render
  // from then on re-sorts and allocates, drag frames included.
  it("keeps a second frame in the order React Flow is given", () => {
    const first = groupSelection({
      nodes: parallelNodes(),
      edges: parallelEdges(),
      selectedIds: new Set(["a", "b", "c"]),
      createId: () => "g1",
    });
    if (!first) {
      throw new Error("expected the parallel fixture to group");
    }

    const second = groupSelection({
      nodes: [
        ...first.nodes,
        action("d", "fountain/get-user", { x: 600, y: 200 }),
        action("e", BUILT_IN_ACTION_IDS.condition, { x: 600, y: 400 }),
      ],
      edges: [...first.edges, edge("de", "d", "e")],
      selectedIds: new Set(["d", "e"]),
      createId: () => "g2",
    });
    if (!second) {
      throw new Error("expected the second chain to group");
    }

    expect(orderGroupParentsFirst(second.nodes)).toBe(second.nodes);
  });

  // Same fast path as above, from the other side: freeing one frame's members
  // leaves them ahead of the frame that stayed, which the phase check refuses.
  it("keeps the order when one of two frames is ungrouped", () => {
    const first = groupSelection({
      nodes: parallelNodes(),
      edges: parallelEdges(),
      selectedIds: new Set(["a", "b", "c"]),
      createId: () => "g1",
    });
    const second = groupSelection({
      nodes: [
        ...(first?.nodes ?? []),
        action("d", "fountain/get-user", { x: 600, y: 200 }),
        action("e", BUILT_IN_ACTION_IDS.condition, { x: 600, y: 400 }),
      ],
      edges: [...(first?.edges ?? []), edge("de", "d", "e")],
      selectedIds: new Set(["d", "e"]),
      createId: () => "g2",
    });
    if (!second) {
      throw new Error("expected two frames");
    }

    const freed = ungroupNode({
      nodes: second.nodes,
      edges: second.edges,
      groupId: "g1",
    });
    expect(orderGroupParentsFirst(freed)).toBe(freed);
  });

  it("nests a lookup chain under a frame with relative positions", () => {
    const nodes = [
      action("a", "fountain/get-user", { x: 100, y: 200 }),
      action("b", "fountain/get-appointment", { x: 100, y: 400 }),
      action("c", BUILT_IN_ACTION_IDS.condition, { x: 100, y: 600 }),
    ];
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "c")];

    const grouped = groupSelection({
      nodes,
      edges,
      selectedIds: new Set(["a", "b", "c"]),
      createId: () => "g1",
    });

    expect(grouped).not.toBeNull();
    const frame = grouped?.nodes.find((node) => node.id === "g1");
    const children = grouped?.nodes.filter((node) => node.parentId === "g1");
    expect(frame?.data).toEqual({
      label: "Group",
      type: "group",
      config: { direction: "vertical" },
    });
    expect(frame?.position).toEqual({ x: 100, y: 200 });
    expect(children?.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(children?.every((node) => node.extent === "parent")).toBe(true);
    expect(children?.[0]?.position.y).toBeLessThan(
      children?.[1]?.position.y ?? 0
    );

    const restored = ungroupNode({
      nodes: grouped?.nodes ?? [],
      edges,
      groupId: "g1",
    });
    expect(restored.some((node) => node.id === "g1")).toBe(false);
    expect(restored.every((node) => !node.parentId)).toBe(true);
  });

  it("places parallel lookups side by side and leaves the stored edges alone", () => {
    const grouped = groupSelection({
      nodes: parallelNodes(),
      edges: parallelEdges(),
      selectedIds: new Set(["a", "b", "c"]),
      createId: () => "g1",
    });

    expect(grouped).not.toBeNull();
    const frame = grouped?.nodes.find((node) => node.id === "g1");
    const childA = grouped?.nodes.find((node) => node.id === "a");
    const childB = grouped?.nodes.find((node) => node.id === "b");
    const childC = grouped?.nodes.find((node) => node.id === "c");
    expect(frame?.data).toEqual({
      label: "Group",
      type: "group",
      config: { direction: "vertical" },
    });
    // Row 0 fills the frame: `GROUP_PAD`, then one card and one gap over.
    expect(childA?.position.x).toBe(12);
    expect(childB?.position.x).toBe(224);
    expect(childA?.position.y).toBe(48);
    expect(childB?.position.y).toBe(48);
    // Row 1 holds the join alone, indented by half a column so it sits under
    // the centre of the row above and the interior edges paint as a fan-in.
    expect(childC?.position.x).toBe(118);
    expect(childC?.position.y).toBe(144);
    expect(grouped?.edges).toEqual(parallelEdges());
  });

  it("groups parallel terminal lookups side by side", () => {
    const grouped = groupSelection({
      nodes: [
        action("a", "fountain/get-user", { x: 100, y: 200 }),
        action("b", "fountain/get-appointment", { x: 400, y: 200 }),
      ],
      edges: [],
      selectedIds: new Set(["a", "b"]),
      createId: () => "g1",
    });

    expect(grouped).not.toBeNull();
    const frame = grouped?.nodes.find((node) => node.id === "g1");
    const childA = grouped?.nodes.find((node) => node.id === "a");
    const childB = grouped?.nodes.find((node) => node.id === "b");
    expect(frame?.data).toEqual({
      label: "Group",
      type: "group",
      config: { direction: "vertical" },
    });
    expect(childA?.position.y).toBe(childB?.position.y);
    expect(childA?.position.x).toBeLessThan(childB?.position.x ?? 0);
  });

  it("frees the members at auto-layout's pitch, keeping the fan-in", () => {
    const freed = ungroupNode({
      nodes: framedNodes(),
      edges: parallelEdges(),
      groupId: "g1",
    });
    const freeA = freed.find((node) => node.id === "a");
    const freeB = freed.find((node) => node.id === "b");
    const freeC = freed.find((node) => node.id === "c");

    expect(freed.some((node) => node.id === "g1")).toBe(false);
    expect(freed.every((node) => !node.parentId)).toBe(true);
    expect((freeB?.position.x ?? 0) - (freeA?.position.x ?? 0)).toBe(
      WORKFLOW_NODE_WIDTH + NODE_SPACING
    );
    expect((freeC?.position.y ?? 0) - (freeA?.position.y ?? 0)).toBe(
      WORKFLOW_NODE_HEIGHT + RANK_SPACING
    );
    expect(freeA?.position.y).toBe(freeB?.position.y);
    // The join stays centred under the two lookups it joins.
    expect(freeC?.position.x).toBe(
      ((freeA?.position.x ?? 0) + (freeB?.position.x ?? 0)) / 2
    );
    expect(freeA?.width).toBe(WORKFLOW_NODE_WIDTH);
    expect(freeA?.height).toBe(WORKFLOW_NODE_HEIGHT);
  });

  it("centres two and three columns of freed members under the collapsed card", () => {
    const frame: WorkflowNode = {
      id: "g1",
      type: "group",
      position: { x: 500, y: 300 },
      width: WORKFLOW_NODE_WIDTH,
      height: WORKFLOW_NODE_HEIGHT,
      data: { label: "Group", type: "group" },
    };
    const cardCentre = frame.position.x + WORKFLOW_NODE_WIDTH / 2;
    const member = (id: string): WorkflowNode => ({
      ...action(id, "fountain/get-user", { x: 12, y: 48 }),
      parentId: "g1",
    });

    for (const ids of [
      ["a", "b"],
      ["a", "b", "c"],
    ]) {
      const freed = ungroupNode({
        nodes: [frame, ...ids.map(member)],
        edges: [],
        groupId: "g1",
      });
      const left = Math.min(...freed.map((node) => node.position.x));
      const right = Math.max(
        ...freed.map((node) => node.position.x + WORKFLOW_NODE_WIDTH)
      );
      expect((left + right) / 2).toBe(cardCentre);
      expect(freed.every((node) => node.position.y === frame.position.y)).toBe(
        true
      );
    }
  });
});

/**
 * What the engine walks: the stored edges, and each executable node's id and
 * data. Membership and geometry are editor organization and stay out of it.
 */
function traversalGraph(nodes: readonly WorkflowNode[], edges: WorkflowEdge[]) {
  return {
    nodes: nodes
      .filter((node) => node.data.type !== "group")
      .map((node) => ({ id: node.id, data: node.data })),
    edges,
  };
}

describe("grouping and the engine traversal graph", () => {
  it("groups and ungroups without changing the stored edges or executable nodes", () => {
    const nodes = parallelNodes().map((node) => ({ ...node, selected: false }));
    const edges = parallelEdges();
    const before = traversalGraph(nodes, edges);

    const grouped = groupSelection({
      nodes,
      edges,
      selectedIds: new Set(["a", "b", "c"]),
      createId: () => "g1",
    });
    if (!grouped) {
      throw new Error("expected the parallel fixture to group");
    }
    expect(traversalGraph(grouped.nodes, grouped.edges)).toEqual(before);

    const freed = ungroupNode({
      nodes: grouped.nodes,
      edges: grouped.edges,
      groupId: "g1",
    });
    expect(traversalGraph(freed, grouped.edges)).toEqual(before);
  });
});

describe("connecting onto a grouped frame", () => {
  // Grouping adds no edge, so `b` keeps no incoming edge while `a` is entered
  // from the Lifecycle Node. The frame's inlet stands for both.
  it("wires every member an edge enters and every member no edge enters", () => {
    const nodes = [
      ...framedNodes(),
      action("x", "fountain/get-user", { x: 0, y: 0 }),
    ];

    expect(
      fanOutStoreEdges({
        nodes,
        edges: parallelEdges().filter((item) => item.id !== "in-b"),
        sourceId: "x",
        targetId: "g1",
        sourceHandle: undefined,
      })
    ).toEqual([
      { source: "x", target: "a", sourceHandle: undefined },
      { source: "x", target: "b", sourceHandle: undefined },
    ]);
  });
});

/** Holds every Group in `nodes` to the rules a save checks. */
function expectWholeGroups(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  expect(
    groupStructureRefusalReason({
      nodes: toPersistedNodes(nodes),
      edges: edges.map(toPersistedEdge),
    })
  ).toBeNull();
  expect(undersizedGroupIds(nodes)).toEqual([]);
}

describe("removeNodes", () => {
  it("ungroups a removed frame and keeps its members and stored edges", () => {
    const nodes = framedNodes();
    const edges = parallelEdges();

    const removed = removeNodes({ nodes, edges, nodeIds: new Set(["g1"]) });

    expect(removed.nodes.map((node) => node.id)).toEqual([
      "life",
      "a",
      "b",
      "c",
    ]);
    expect(removed.edges).toBe(edges);
    const freed = removed.nodes.find((node) => node.id === "a");
    expect(freed).not.toHaveProperty("parentId");
    expect(freed).not.toHaveProperty("extent");
    expect(freed?.draggable).toBe(true);
    expect(freed?.connectable).toBe(true);
    expectWholeGroups(removed.nodes, removed.edges);
  });

  it("removes the members a batch names beside their ungrouped frame", () => {
    // A box selection over a frame and one member: the member goes with its
    // stored edges, and the frame is ungrouped, freeing the members left.
    const removed = removeNodes({
      nodes: framedNodes(),
      edges: parallelEdges(),
      nodeIds: new Set(["g1", "a"]),
    });

    expect(removed.nodes.map((node) => [node.id, node.parentId])).toEqual([
      ["life", undefined],
      ["b", undefined],
      ["c", undefined],
    ]);
    expect(removed.nodes[1]?.draggable).toBe(true);
    expect(removed.edges.map((item) => item.id)).toEqual(["in-b", "b-c"]);
    expectWholeGroups(removed.nodes, removed.edges);
  });

  it("removes every member and the frame when a batch names them all", () => {
    const removed = removeNodes({
      nodes: framedNodes(),
      edges: parallelEdges(),
      nodeIds: new Set(["g1", "a", "b", "c"]),
    });

    expect(removed.nodes.map((node) => node.id)).toEqual(["life"]);
    expect(removed.edges).toEqual([]);
  });

  it("removes a member with its stored edges and keeps a Group of two", () => {
    const removed = removeNodes({
      nodes: framedNodes(),
      edges: parallelEdges(),
      nodeIds: new Set(["a"]),
    });

    expect(removed.nodes.map((node) => [node.id, node.parentId])).toEqual([
      ["life", undefined],
      ["g1", undefined],
      ["b", "g1"],
      ["c", "g1"],
    ]);
    expect(removed.edges.map((item) => item.id)).toEqual(["in-b", "b-c"]);
    expectWholeGroups(removed.nodes, removed.edges);
  });

  it("ungroups a Group the removal leaves with one member", () => {
    const removed = removeNodes({
      nodes: framedNodes(),
      edges: parallelEdges(),
      nodeIds: new Set(["a", "b"]),
    });

    expect(removed.nodes.map((node) => node.id)).toEqual(["life", "c"]);
    expect(removed.nodes[1]).not.toHaveProperty("parentId");
    expect(removed.edges).toEqual([]);
    expectWholeGroups(removed.nodes, removed.edges);
  });

  it("keeps the Lifecycle Node and answers the same arrays for nothing", () => {
    const nodes = framedNodes();
    const edges = parallelEdges();

    const removed = removeNodes({ nodes, edges, nodeIds: new Set(["life"]) });

    expect(removed.nodes).toBe(nodes);
    expect(removed.edges).toBe(edges);
  });
});

describe("removeGroupWithMembers", () => {
  it("removes the frame, its members, and every edge touching a member", () => {
    const nodes = [
      ...framedNodes(),
      action("after", "fountain/get-user", { x: 0, y: 600 }),
    ];
    const edges = [...parallelEdges(), edge("c-after", "c", "after", "true")];

    const removed = removeGroupWithMembers({ nodes, edges, groupId: "g1" });

    expect(removed.nodes.map((node) => node.id)).toEqual(["life", "after"]);
    expect(removed.edges).toEqual([]);
    expectWholeGroups(removed.nodes, removed.edges);
  });

  it("answers the same arrays for an id that names no frame", () => {
    const nodes = framedNodes();
    const edges = parallelEdges();

    const removed = removeGroupWithMembers({ nodes, edges, groupId: "a" });

    expect(removed.nodes).toBe(nodes);
    expect(removed.edges).toBe(edges);
  });
});

describe("repairCanvasGroups", () => {
  it("frees a lone member at canvas size and leaves a whole Group alone", () => {
    const whole = framedNodes();
    expect(repairCanvasGroups({ nodes: whole, edges: [] })).toEqual({
      ok: true,
      nodes: whole,
      dissolvedGroupIds: [],
    });

    const lone = whole.filter((node) => node.id !== "a" && node.id !== "b");
    const repair = repairCanvasGroups({ nodes: lone, edges: [] });
    if (!repair.ok) {
      throw new Error("expected the repair to succeed");
    }

    expect(repair.dissolvedGroupIds).toEqual(["g1"]);
    expect(repair.nodes.map((node) => node.id)).toEqual(["life", "c"]);
    expect(repair.nodes[1]?.width).toBe(WORKFLOW_NODE_WIDTH);
    expect(repair.nodes[1]?.height).toBe(WORKFLOW_NODE_HEIGHT);
    expect(repair.nodes[1]).not.toHaveProperty("extent");
  });

  it("frees a lone member onto the collapsed card, whatever it stored", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "g1",
        type: "group",
        position: { x: 100, y: 50 },
        data: { label: "Group", type: "group" },
      },
      {
        ...action("a", "fountain/get-user", { x: 12, y: 40 }),
        parentId: "g1",
        extent: "parent",
      },
    ];

    const repair = repairCanvasGroups({ nodes, edges: [] });

    expect(
      repair.ok && repair.nodes.map((node) => [node.id, node.position])
    ).toEqual([["a", { x: 100, y: 50 }]]);
  });

  it("refuses a graph whose stored edge names a frame", () => {
    const repair = repairCanvasGroups({
      nodes: framedNodes(),
      edges: [edge("in-g", "life", "g1", "started")],
    });

    expect(repair.ok).toBe(false);
  });
});

describe("canUngroup", () => {
  it("answers for a frame and for a member, and for nothing else", () => {
    const frame: WorkflowNode = {
      id: "g1",
      type: "group",
      position: { x: 0, y: 0 },
      data: { label: "Group", type: "group", config: {} },
    };
    const member = {
      ...action("a", "fountain/get-user", { x: 0, y: 0 }),
      parentId: "g1",
    };

    expect(canUngroup(frame)).toBe(true);
    expect(canUngroup(member)).toBe(true);
    expect(
      canUngroup(action("free", "fountain/get-user", { x: 0, y: 0 }))
    ).toBe(false);
    expect(canUngroup(undefined)).toBe(false);
  });
});
