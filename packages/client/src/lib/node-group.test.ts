import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { groupSelection, ungroupNode } from "#src/lib/node-group";
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

function edge(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target };
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
      entryNodeId: "a",
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
});
