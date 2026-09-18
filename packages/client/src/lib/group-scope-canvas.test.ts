import { describe, expect, it } from "vitest";
import type { NodeChange } from "@xyflow/react";
import { groupCanvasPositions } from "@wfgraph/shared/graph/node-group";
import {
  boundaryStubId,
  focusedGroupCanvasGraph,
  GROUP_BOUNDARY_NODE_TYPES,
  GROUP_BOUNDARY_STUB_HEIGHT,
  overviewCanvasGraph,
  scopeCanvasGraph,
  withoutProjectedDimensions,
} from "#src/lib/group-scope-canvas";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  GROUP_CHILD_HEIGHT,
  GROUP_CHILD_WIDTH,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";

function step(
  id: string,
  position: { x: number; y: number },
  parentId?: string
): WorkflowNode {
  const node: WorkflowNode = {
    id,
    type: "action",
    position,
    data: { label: id, type: "action", config: { actionType: "mailer/send" } },
  };
  return parentId
    ? {
        ...node,
        parentId,
        extent: "parent",
        draggable: false,
        width: GROUP_CHILD_WIDTH,
        height: GROUP_CHILD_HEIGHT,
      }
    : node;
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return sourceHandle
    ? { id, source, target, sourceHandle }
    : { id, source, target };
}

const FRAME: WorkflowNode = {
  id: "g",
  type: "group",
  position: { x: 400, y: 300 },
  width: 424,
  height: 200,
  style: { width: 424, height: 200 },
  data: { label: "Outreach", type: "group" },
};

const NODES: WorkflowNode[] = [
  {
    id: "life",
    type: "lifecycle",
    position: { x: 400, y: 0 },
    data: { label: "", type: "lifecycle" },
  },
  step("before", { x: 400, y: 150 }),
  FRAME,
  step("a", { x: 12, y: 48 }, "g"),
  step("b", { x: 12, y: 144 }, "g"),
  step("after", { x: 400, y: 600 }),
];

const EDGES: WorkflowEdge[] = [
  edge("life-before", "life", "before", "started"),
  edge("before-a", "before", "a"),
  edge("a-b", "a", "b"),
  edge("b-after", "b", "after"),
];

describe("overviewCanvasGraph", () => {
  it("draws each Group as one collapsed card with its boundary on the frame", () => {
    const graph = overviewCanvasGraph({ nodes: NODES, edges: EDGES });

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "life",
      "before",
      "g",
      "after",
    ]);
    const frame = graph.nodes.find((node) => node.id === "g");
    expect(frame).toMatchObject({
      width: WORKFLOW_NODE_WIDTH,
      height: WORKFLOW_NODE_HEIGHT,
      measured: { width: WORKFLOW_NODE_WIDTH, height: WORKFLOW_NODE_HEIGHT },
      position: FRAME.position,
      style: {},
    });
    expect(graph.anchor).toEqual({ nodeId: "life", pinToTop: true });
    expect([...graph.projectedNodeIds]).toEqual(["g"]);
    expect(
      graph.edges.map((item) => [item.id, item.source, item.target])
    ).toEqual([
      ["life-before", "life", "before"],
      ["before-a", "before", "g"],
      ["b-after", "g", "after"],
    ]);
  });

  it("answers the same graph when nothing is grouped", () => {
    const input = {
      nodes: [step("x", { x: 0, y: 0 })],
      edges: [] as WorkflowEdge[],
    };
    const graph = overviewCanvasGraph(input);
    expect(graph.nodes).toBe(input.nodes);
    expect(graph.edges).toBe(input.edges);
  });

  it("keeps a collapsed frame's identity across repaints", () => {
    const first = overviewCanvasGraph({ nodes: NODES, edges: EDGES });
    const second = overviewCanvasGraph({ nodes: [...NODES], edges: EDGES });
    expect(second.nodes[2]).toBe(first.nodes[2]);
  });
});

const ingress = (nodeId: string, handle: string | null = null) =>
  boundaryStubId("ingress", { nodeId, handle });
const continuation = (nodeId: string, handle: string | null = null) =>
  boundaryStubId("continuation", { nodeId, handle });

function focused(
  nodes: WorkflowNode[] = NODES,
  edges: WorkflowEdge[] = EDGES
): NonNullable<ReturnType<typeof focusedGroupCanvasGraph>> {
  const graph = focusedGroupCanvasGraph({ nodes, edges, groupId: "g" });
  if (!graph) {
    throw new Error("the Group was not found");
  }
  return graph;
}

const CARD = { width: WORKFLOW_NODE_WIDTH, height: WORKFLOW_NODE_HEIGHT };

describe("focusedGroupCanvasGraph", () => {
  it("lays the members out from topology, with stubs and no frame", () => {
    const graph = focused();
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(byId.has("g")).toBe(false);
    expect(byId.has("before")).toBe(false);

    const positions = groupCanvasPositions({
      memberIds: ["a", "b"],
      interiorEdges: [EDGES[2]],
    });
    const a = byId.get("a");
    expect(a).toMatchObject({
      ...CARD,
      measured: CARD,
      draggable: false,
      connectable: false,
      position: positions.get("a"),
    });
    expect(byId.get("b")?.position).toEqual(positions.get("b"));
    expect(a).not.toHaveProperty("parentId");
    expect(a).not.toHaveProperty("extent");

    const stubIn = byId.get(ingress("before"));
    const stubOut = byId.get(continuation("after"));
    const stubSize = {
      width: WORKFLOW_NODE_WIDTH,
      height: GROUP_BOUNDARY_STUB_HEIGHT,
    };
    expect(stubIn).toMatchObject({
      type: GROUP_BOUNDARY_NODE_TYPES.ingress,
      ...stubSize,
      measured: stubSize,
      selectable: false,
      deletable: false,
      data: { label: "before", type: "action" },
    });
    expect(stubOut?.type).toBe(GROUP_BOUNDARY_NODE_TYPES.continuation);
    expect(stubIn?.position.y ?? 0).toBeLessThan(a?.position.y ?? 0);
    expect(stubOut?.position.y ?? 0).toBeGreaterThan(
      byId.get("b")?.position.y ?? 0
    );

    expect(
      graph.edges.map((item) => [
        item.id,
        item.source,
        item.target,
        item.selectable,
        item.deletable,
      ])
    ).toEqual([
      ["a-b", "a", "b", false, false],
      ["before-a", ingress("before"), "a", false, false],
      ["b-after", "b", continuation("after"), false, false],
    ]);
    expect(graph.anchor).toEqual({ nodeId: "a", pinToTop: false });
    expect(graph.projectedNodeIds).toEqual(new Set(byId.keys()));
  });

  it("ignores where the collapsed card and the stored slots are", () => {
    const first = focused();
    const moved = NODES.map((node) => {
      if (node.id === "g") {
        return { ...node, position: { x: 4000, y: -900 }, width: 900 };
      }
      return node.parentId ? { ...node, position: { x: 700, y: 0 } } : node;
    });
    const second = focused(moved);
    expect(second.nodes.map((node) => [node.id, node.position])).toEqual(
      first.nodes.map((node) => [node.id, node.position])
    );
  });

  it("re-projects when interior edges change and writes nothing", () => {
    const nodes = structuredClone(NODES);
    const stacked = focused(nodes);
    const sideBySide = focused(nodes, [EDGES[0], EDGES[1]]);
    const y = (graph: typeof stacked, id: string) =>
      graph.nodes.find((node) => node.id === id)?.position.y;
    expect(y(stacked, "a")).not.toBe(y(stacked, "b"));
    expect(y(sideBySide, "a")).toBe(y(sideBySide, "b"));
    expect(nodes).toEqual(NODES);
  });

  it("keeps each painted node's identity across an unchanged recompute", () => {
    const first = focused();
    const second = focused([...NODES], [...EDGES]);
    second.nodes.forEach((node, index) => {
      expect(node).toBe(first.nodes[index]);
    });
    second.edges.forEach((item, index) => {
      expect(item).toBe(first.edges[index]);
    });
  });

  it("draws one labelled stub edge per branch of an outside Condition", () => {
    const check: WorkflowNode = {
      ...step("check", { x: 0, y: 0 }),
      data: {
        label: "Check",
        type: "action",
        config: { actionType: "condition" },
      },
    };
    const graph = focused(
      [...NODES, check],
      [
        edge("true-a", "check", "a", "true"),
        edge("false-a", "check", "a", "false"),
        edge("a-b", "a", "b"),
      ]
    );
    expect(
      graph.nodes
        .filter((node) => node.type === GROUP_BOUNDARY_NODE_TYPES.ingress)
        .map((node) => node.id)
    ).toEqual([ingress("check", "true"), ingress("check", "false")]);
    expect(
      graph.edges
        .filter((item) => item.target === "a")
        .map((item) => [item.source, item.data?.displayLabel])
    ).toEqual([
      [ingress("check", "true"), "True"],
      [ingress("check", "false"), "False"],
    ]);
  });

  it("names the Lifecycle Node through the stub's own data", () => {
    const graph = focused(NODES, [
      edge("life-a", "life", "a", "started"),
      edge("a-b", "a", "b"),
    ]);
    const stub = graph.nodes.find(
      (node) => node.id === ingress("life", "started")
    );
    expect(stub?.data.type).toBe("lifecycle");
    const painted = graph.edges.find((item) => item.id === "life-a");
    expect(painted).not.toHaveProperty("sourceHandle");
  });

  it("answers null for a Group the graph does not hold", () => {
    expect(
      focusedGroupCanvasGraph({ nodes: NODES, edges: EDGES, groupId: "a" })
    ).toBeNull();
  });

  it("leaves the stored nodes and edges untouched", () => {
    const nodes = structuredClone(NODES);
    const edges = structuredClone(EDGES);
    focusedGroupCanvasGraph({ nodes, edges, groupId: "g" });
    overviewCanvasGraph({ nodes, edges });
    expect(nodes).toEqual(NODES);
    expect(edges).toEqual(EDGES);
  });
});

describe("withoutProjectedDimensions", () => {
  it("drops measurements of projected nodes and keeps every other change", () => {
    const changes: NodeChange<WorkflowNode>[] = [
      { type: "dimensions", id: "a", dimensions: { width: 1, height: 1 } },
      { type: "dimensions", id: "x", dimensions: { width: 1, height: 1 } },
      { type: "select", id: "a", selected: true },
    ];
    expect(
      withoutProjectedDimensions(changes, new Set(["a"])).map((change) => [
        change.type,
        "id" in change ? change.id : null,
      ])
    ).toEqual([
      ["dimensions", "x"],
      ["select", "a"],
    ]);
    expect(withoutProjectedDimensions(changes, new Set())).toBe(changes);
  });
});

describe("scopeCanvasGraph", () => {
  it("shows the overview for a Group scope whose Group is gone", () => {
    const graph = scopeCanvasGraph({
      nodes: NODES,
      edges: EDGES,
      scope: { kind: "group", groupId: "missing" },
    });
    expect(graph.nodes.map((node) => node.id)).toContain("g");
  });
});
