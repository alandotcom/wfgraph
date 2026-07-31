import { describe, expect, test } from "vitest";
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "@rova/shared/graph/types";
import { layoutWorkflowNodes } from "./workflow-layout";

function buildNode(
  id: string,
  position: { x: number; y: number },
  type: WorkflowNodeType = "action"
): WorkflowNode {
  return {
    id,
    type,
    position,
    data: {
      label: id,
      type,
      status: "idle",
    },
  };
}

function buildEdge(id: string, source: string, target: string): WorkflowEdge {
  return {
    id,
    source,
    target,
  };
}

describe("layoutWorkflowNodes", () => {
  test("returns unchanged result when no nodes exist", async () => {
    const result = await layoutWorkflowNodes({ nodes: [], edges: [] });
    expect(result.changed).toBe(false);
    expect(result.nodes).toEqual([]);
  });

  test("keeps canonical single-node position unchanged", async () => {
    const nodes = [buildNode("a", { x: 40, y: 40 })];
    const result = await layoutWorkflowNodes({ nodes, edges: [] });
    expect(result.changed).toBe(false);
    expect(result.nodes[0]?.position).toEqual({ x: 40, y: 40 });
  });

  test("is deterministic for the same graph input", async () => {
    const nodes = [
      buildNode("lifecycle", { x: 80, y: 80 }, "lifecycle"),
      buildNode("left", { x: 460, y: 260 }),
      buildNode("right", { x: 620, y: 260 }),
    ];
    const edges = [
      buildEdge("e1", "lifecycle", "left"),
      buildEdge("e2", "lifecycle", "right"),
    ];

    const first = await layoutWorkflowNodes({ nodes, edges });
    const second = await layoutWorkflowNodes({
      nodes: first.nodes,
      edges,
    });

    expect(second.nodes.map((node) => node.position)).toEqual(
      first.nodes.map((node) => node.position)
    );
  });

  test("falls back to dagre for non-tree graphs", async () => {
    const nodes = [
      buildNode("a", { x: 0, y: 0 }, "lifecycle"),
      buildNode("b", { x: 80, y: 200 }),
      buildNode("c", { x: 220, y: 200 }),
    ];
    const edges = [buildEdge("e1", "a", "c"), buildEdge("e2", "b", "c")];

    const result = await layoutWorkflowNodes({ nodes, edges });

    expect(result.nodes).toHaveLength(3);
    for (const node of result.nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });

  test("ignores dangling edges and still lays out valid nodes", async () => {
    const nodes = [
      buildNode("a", { x: 140, y: 140 }, "lifecycle"),
      buildNode("b", { x: 340, y: 340 }),
    ];
    const edges = [
      buildEdge("valid", "a", "b"),
      buildEdge("dangling-target", "a", "missing"),
      buildEdge("dangling-source", "missing", "b"),
    ];

    const result = await layoutWorkflowNodes({ nodes, edges });
    expect(result.nodes).toHaveLength(2);
    for (const node of result.nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });

  test("keeps add nodes untouched while reflowing workflow nodes", async () => {
    const addNode = buildNode("add-placeholder", { x: 999, y: 999 }, "add");
    const nodes = [
      buildNode("lifecycle", { x: 0, y: 0 }, "lifecycle"),
      buildNode("action", { x: 420, y: 210 }),
      addNode,
    ];
    const edges = [buildEdge("e1", "lifecycle", "action")];

    const result = await layoutWorkflowNodes({ nodes, edges });
    const nextAddNode = result.nodes.find((node) => node.id === addNode.id);

    expect(nextAddNode?.position).toEqual(addNode.position);
    expect(nextAddNode?.type).toBe("add");
  });
});
