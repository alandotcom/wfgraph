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
  lockGroupInteriorEdges,
  refuseDelete,
  ungroupNode,
} from "#src/lib/node-group";
import { orderGroupParentsFirst } from "@wfgraph/shared/graph/node-group";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

/**
 * These cases are about the geometry a frame lays its members out in, so no
 * action needs a catalog entry. An action the catalog does not list declares no
 * side effect, which is what lets these fixtures group.
 */
const emptyCatalog: ExtensionCatalog = {
  events: [],
  actions: [],
  integrations: [],
};

function action(
  id: string,
  actionType: string,
  position: { x: number; y: number }
): WorkflowNode {
  return {
    id,
    type: "action",
    position,
    selected: true,
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
  // React Flow declares `sourceHandle` as a plain optional key, so an edge
  // leaving a node's only handle carries no key at all.
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
      selected: false,
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
    catalog: emptyCatalog,
    createId: () => "g1",
    createEdgeId: () => "in-b",
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
      catalog: emptyCatalog,
      createId: () => "g1",
      createEdgeId: () => "in-b",
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
      catalog: emptyCatalog,
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
      catalog: emptyCatalog,
      createId: () => "g1",
      createEdgeId: () => "in-b",
    });
    const second = groupSelection({
      nodes: [
        ...(first?.nodes ?? []),
        action("d", "fountain/get-user", { x: 600, y: 200 }),
        action("e", BUILT_IN_ACTION_IDS.condition, { x: 600, y: 400 }),
      ],
      edges: [...(first?.edges ?? []), edge("de", "d", "e")],
      selectedIds: new Set(["d", "e"]),
      catalog: emptyCatalog,
      createId: () => "g2",
    });
    if (!second) {
      throw new Error("expected two frames");
    }

    const freed = ungroupNode(second.nodes, "g1");
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
      catalog: emptyCatalog,
      createId: () => "g1",
    });

    expect(grouped).not.toBeNull();
    const frame = grouped?.nodes.find((node) => node.id === "g1");
    const children = grouped?.nodes.filter((node) => node.parentId === "g1");
    expect(frame?.data.config).toEqual({
      entryNodeIds: ["a"],
      exitNodeIds: ["c"],
      outletHandle: "true",
    });
    expect(frame?.position).toEqual({ x: 100, y: 200 });
    expect(children?.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(children?.every((node) => node.extent === "parent")).toBe(true);
    expect(children?.[0]?.position.y).toBeLessThan(
      children?.[1]?.position.y ?? 0
    );

    const restored = ungroupNode(grouped?.nodes ?? [], "g1");
    expect(restored.some((node) => node.id === "g1")).toBe(false);
    expect(restored.every((node) => !node.parentId)).toBe(true);
  });

  it("places parallel lookups side by side and fans incoming onto both", () => {
    const grouped = groupSelection({
      nodes: parallelNodes(),
      edges: parallelEdges(),
      selectedIds: new Set(["a", "b", "c"]),
      catalog: emptyCatalog,
      createId: () => "g1",
      createEdgeId: () => "in-b",
    });

    expect(grouped).not.toBeNull();
    const frame = grouped?.nodes.find((node) => node.id === "g1");
    const childA = grouped?.nodes.find((node) => node.id === "a");
    const childB = grouped?.nodes.find((node) => node.id === "b");
    const childC = grouped?.nodes.find((node) => node.id === "c");
    expect(frame?.data.config).toEqual({
      entryNodeIds: ["a", "b"],
      exitNodeIds: ["c"],
      outletHandle: "true",
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
    expect(
      grouped?.edges.map((item) => `${item.source}->${item.target}`)
    ).toEqual(["life->a", "a->c", "b->c", "life->b"]);
  });

  it("groups parallel terminal lookups side by side", () => {
    const grouped = groupSelection({
      nodes: [
        action("a", "fountain/get-user", { x: 100, y: 200 }),
        action("b", "fountain/get-appointment", { x: 400, y: 200 }),
      ],
      edges: [],
      selectedIds: new Set(["a", "b"]),
      catalog: emptyCatalog,
      createId: () => "g1",
    });

    expect(grouped).not.toBeNull();
    const frame = grouped?.nodes.find((node) => node.id === "g1");
    const childA = grouped?.nodes.find((node) => node.id === "a");
    const childB = grouped?.nodes.find((node) => node.id === "b");
    expect(frame?.data.config).toEqual({
      entryNodeIds: ["a", "b"],
      exitNodeIds: ["a", "b"],
    });
    expect(childA?.position.y).toBe(childB?.position.y);
    expect(childA?.position.x).toBeLessThan(childB?.position.x ?? 0);
  });

  it("frees the members at auto-layout's pitch, keeping the fan-in", () => {
    const freed = ungroupNode(framedNodes(), "g1");
    const freeA = freed.find((node) => node.id === "a");
    const freeB = freed.find((node) => node.id === "b");
    const freeC = freed.find((node) => node.id === "c");

    expect(freed.some((node) => node.id === "g1")).toBe(false);
    expect(freed.every((node) => !node.parentId)).toBe(true);
    // Two siblings sit one auto-layout column apart, and the rank below sits
    // one auto-layout rank down, so nothing overlaps at the compact spacing
    // the frame used.
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
});

describe("refuseDelete", () => {
  const frame: WorkflowNode = {
    id: "g1",
    type: "group",
    position: { x: 0, y: 0 },
    data: {
      label: "Group",
      type: "group",
      config: { entryNodeIds: ["a"], exitNodeIds: ["a"] },
    },
  };
  const member: WorkflowNode = {
    ...action("a", "fountain/get-user", { x: 0, y: 0 }),
    parentId: "g1",
  };
  const free = action("free", "fountain/get-user", { x: 0, y: 0 });

  it("allows a frame taking its members, and a step of its own", () => {
    expect(refuseDelete([frame, member])).toBeNull();
    expect(refuseDelete([free])).toBeNull();
    expect(refuseDelete([])).toBeNull();
  });

  it("refuses a batch reaching into a frame it does not take", () => {
    expect(refuseDelete([member])).toBe(
      "Ungroup the frame before deleting a step inside it"
    );
    expect(refuseDelete([free, member])).toBe(
      "Ungroup the frame before deleting a step inside it"
    );
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

describe("lockGroupInteriorEdges", () => {
  it("locks an edge between two members and leaves the rest alone", () => {
    const nodes = [
      ...framedNodes(),
      action("outside", "fountain/get-user", { x: 0, y: 0 }),
    ];
    const edges = [edge("a-c", "a", "c"), edge("c-out", "c", "outside")];

    const locked = lockGroupInteriorEdges(nodes, edges);

    expect(locked[0]?.selectable).toBe(false);
    expect(locked[0]?.deletable).toBe(false);
    expect(locked[0]?.focusable).toBe(false);
    expect(locked[1]).toBe(edges[1]);
  });

  it("hands back the same locked object on a later recompute", () => {
    const nodes = framedNodes();
    const edges = [edge("a-c", "a", "c")];

    // A node drag rebuilds the node array without touching parentage or the
    // edges. React Flow re-renders an edge whose object changed, so a fresh
    // copy per recompute would repaint every interior edge on every frame.
    const first = lockGroupInteriorEdges(nodes, edges);
    const second = lockGroupInteriorEdges([...nodes], edges);

    expect(second[0]).toBe(first[0]);
  });

  it("returns the same array when nothing is nested", () => {
    const nodes = [action("a", "fountain/get-user", { x: 0, y: 0 })];
    const edges = [edge("e", "a", "a")];

    expect(lockGroupInteriorEdges(nodes, edges)).toBe(edges);
  });
});
