import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  GROUP_CHILD_WIDTH,
  GROUP_COLUMN_GAP,
  GROUP_PAD,
} from "#src/components/workflow/workflow-node-dimensions";
import {
  deletesMembersWithTheirFrame,
  groupSelection,
  lockGroupInteriorEdges,
  refuseNodeDelete,
  ungroupNode,
} from "#src/lib/node-group";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

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
  return { id, source, target, sourceHandle };
}

describe("groupSelection", () => {
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
    expect(frame?.data.config).toEqual({
      entryNodeIds: ["a"],
      exitNodeId: "c",
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
    const nodes = [
      action("life", "ignored", { x: 0, y: 0 }),
      action("a", "fountain/get-user", { x: 40, y: 200 }),
      action("b", "fountain/get-appointment", { x: 240, y: 200 }),
      action("c", BUILT_IN_ACTION_IDS.condition, { x: 140, y: 400 }),
    ];
    nodes[0] = {
      ...nodes[0],
      type: "lifecycle",
      selected: false,
      data: { label: "Start", type: "lifecycle", config: {} },
    };
    const edges = [
      edge("in-a", "life", "a", "started"),
      edge("a-c", "a", "c"),
      edge("b-c", "b", "c"),
    ];

    const grouped = groupSelection({
      nodes,
      edges,
      selectedIds: new Set(["a", "b", "c"]),
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
      exitNodeId: "c",
      outletHandle: "true",
    });
    expect(childA?.position).toEqual({ x: GROUP_PAD, y: childA?.position.y });
    expect(childB?.position.x).toBe(
      GROUP_PAD + GROUP_CHILD_WIDTH + GROUP_COLUMN_GAP
    );
    expect(childA?.position.y).toBe(childB?.position.y);
    expect(childC?.position.y).toBeGreaterThan(childA?.position.y ?? 0);
    // The join sits centred between the two lookups it joins, so the interior
    // edges paint as a fan-in.
    const rowCentre =
      (childA?.position.x ?? 0) +
      ((childB?.position.x ?? 0) +
        GROUP_CHILD_WIDTH -
        (childA?.position.x ?? 0)) /
        2;
    expect((childC?.position.x ?? 0) + GROUP_CHILD_WIDTH / 2).toBe(rowCentre);
    expect(
      grouped?.edges.map((item) => `${item.source}->${item.target}`)
    ).toEqual(["life->a", "a->c", "b->c", "life->b"]);
  });
});

describe("refuseNodeDelete", () => {
  it("refuses a member and allows the frame and a free step", () => {
    const nodes: WorkflowNode[] = [
      {
        id: "g1",
        type: "group",
        position: { x: 0, y: 0 },
        data: {
          label: "Group",
          type: "group",
          config: { entryNodeIds: ["a"], exitNodeId: "c" },
        },
      },
      { ...action("a", "fountain/get-user", { x: 0, y: 0 }), parentId: "g1" },
      action("free", "fountain/get-user", { x: 0, y: 0 }),
    ];

    expect(refuseNodeDelete(nodes, "a")).toBe(
      "Ungroup the frame before deleting this step"
    );
    expect(refuseNodeDelete(nodes, "g1")).toBeNull();
    expect(refuseNodeDelete(nodes, "free")).toBeNull();
  });
});

describe("deletesMembersWithTheirFrame", () => {
  const frame: WorkflowNode = {
    id: "g1",
    type: "group",
    position: { x: 0, y: 0 },
    data: {
      label: "Group",
      type: "group",
      config: { entryNodeIds: ["a"], exitNodeId: "a" },
    },
  };
  const member: WorkflowNode = {
    ...action("a", "fountain/get-user", { x: 0, y: 0 }),
    parentId: "g1",
  };
  const free = action("free", "fountain/get-user", { x: 0, y: 0 });

  it("allows a frame taking its members and a step of its own", () => {
    expect(deletesMembersWithTheirFrame([frame, member])).toBe(true);
    expect(deletesMembersWithTheirFrame([free])).toBe(true);
  });

  it("refuses a member whose frame stays", () => {
    expect(deletesMembersWithTheirFrame([member])).toBe(false);
    expect(deletesMembersWithTheirFrame([free, member])).toBe(false);
  });
});

describe("lockGroupInteriorEdges", () => {
  it("locks an edge between two members and leaves the rest alone", () => {
    const nodes: WorkflowNode[] = [
      { ...action("a", "fountain/get-user", { x: 0, y: 0 }), parentId: "g1" },
      {
        ...action("c", BUILT_IN_ACTION_IDS.condition, { x: 0, y: 0 }),
        parentId: "g1",
      },
      action("outside", "fountain/get-user", { x: 0, y: 0 }),
    ];
    const edges = [edge("a-c", "a", "c"), edge("c-out", "c", "outside")];

    const locked = lockGroupInteriorEdges(nodes, edges);

    expect(locked[0]?.selectable).toBe(false);
    expect(locked[0]?.deletable).toBe(false);
    expect(locked[1]).toBe(edges[1]);
  });

  it("returns the same array when nothing is nested", () => {
    const nodes = [action("a", "fountain/get-user", { x: 0, y: 0 })];
    const edges = [edge("e", "a", "a")];

    expect(lockGroupInteriorEdges(nodes, edges)).toBe(edges);
  });
});
