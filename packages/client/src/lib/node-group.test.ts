import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  GROUP_CHILD_GAP,
  GROUP_CHILD_WIDTH,
  GROUP_PAD,
} from "#src/components/workflow/workflow-node-dimensions";
import {
  groupSelection,
  groupingIdsFromSnapshot,
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
    });
    expect(childA?.position).toEqual({ x: GROUP_PAD, y: childA?.position.y });
    expect(childB?.position.x).toBe(
      GROUP_PAD + GROUP_CHILD_WIDTH + GROUP_CHILD_GAP
    );
    expect(childA?.position.y).toBe(childB?.position.y);
    expect(childC?.position.y).toBeGreaterThan(childA?.position.y ?? 0);
    expect(
      grouped?.edges.map((item) => `${item.source}->${item.target}`)
    ).toEqual(["life->a", "a->c", "b->c", "life->b"]);
  });
});

describe("groupingIdsFromSnapshot", () => {
  it("keeps the frozen multi-select when the click target is in it", () => {
    const nodes = [
      action("a", "fountain/get-user", { x: 0, y: 0 }),
      action("b", "fountain/get-appointment", { x: 0, y: 0 }),
      action("c", BUILT_IN_ACTION_IDS.condition, { x: 0, y: 0 }),
    ].map((node) => (node.id === "a" ? node : { ...node, selected: false }));

    expect(groupingIdsFromSnapshot(nodes, "a", ["a", "b", "c"])).toEqual(
      new Set(["a", "b", "c"])
    );
  });

  it("falls back to the live selection when the snapshot is a single node", () => {
    const nodes = [
      action("a", "fountain/get-user", { x: 0, y: 0 }),
      {
        ...action("b", "fountain/get-appointment", { x: 0, y: 0 }),
        selected: false,
      },
    ];

    expect(groupingIdsFromSnapshot(nodes, "a", ["a"])).toEqual(new Set(["a"]));
  });
});
