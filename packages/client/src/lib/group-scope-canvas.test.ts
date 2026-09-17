import { describe, expect, it } from "vitest";
import { type NodeChange, Position } from "@xyflow/react";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { resolveEdgeLabel } from "#src/components/flow-elements/edge-label";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { layoutWorkflowNodes } from "#src/components/workflow/workflow-layout";
import { rectanglesOverlap } from "@wfgraph/shared/graph/node-placement";
import {
  boundaryStubId,
  focusedGroupCanvasGraph,
  overviewCanvasGraph,
  scopeCanvasGraph,
  storedCanvasConnection,
  withoutProjectedDimensions,
} from "#src/lib/group-scope-canvas";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";

function step(
  id: string,
  x: number,
  y: number,
  parentId?: string
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x, y },
    ...(parentId
      ? { parentId, extent: "parent" as const, draggable: false }
      : {}),
    data: { label: id, type: "action", config: { actionType: "mailer/send" } },
  };
}
const frame: WorkflowNode = {
  id: "g",
  type: "group",
  position: { x: 400, y: 300 },
  width: 800,
  height: 700,
  data: { label: "Group", type: "group" },
};
const nodes = [
  step("before", 400, 0),
  frame,
  step("a", 12, 48, "g"),
  step("b", 312, 260, "g"),
  step("after", 400, 900),
];
const edges: WorkflowEdge[] = [
  { id: "in", source: "before", target: "a" },
  { id: "ab", source: "a", target: "b" },
  { id: "out", source: "b", target: "after" },
];
const ingress = (nodeId = "before", handle: string | null = null) =>
  boundaryStubId("ingress", { nodeId, handle });
const continuation = () =>
  boundaryStubId("continuation", { nodeId: "after", handle: null });
const end = (nodeId: string, handle: string | null = null) =>
  boundaryStubId("end", { nodeId, handle });
function focused(inputNodes = nodes, inputEdges = edges) {
  const graph = focusedGroupCanvasGraph({
    nodes: inputNodes,
    edges: inputEdges,
    groupId: "g",
  });
  if (!graph) throw new Error("expected Group");
  return graph;
}
const position = (graph: ReturnType<typeof focused>, id: string) =>
  graph.nodes.find((node) => node.id === id)?.position;

describe("Group canvas projection", () => {
  it("collapses the overview without changing stored members", () => {
    const graph = overviewCanvasGraph({ nodes, edges });
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "before",
      "g",
      "after",
    ]);
    expect(graph.nodes[1]).toMatchObject({
      position: frame.position,
      width: WORKFLOW_NODE_WIDTH,
      height: WORKFLOW_NODE_HEIGHT,
    });
    expect(
      graph.edges.map((edge) => [edge.id, edge.source, edge.target])
    ).toEqual([
      ["in", "before", "g"],
      ["out", "g", "after"],
    ]);
    expect(graph.projectedNodeIds).toEqual(new Set(["g"]));
    expect(overviewCanvasGraph({ nodes, edges }).nodes[1]).toBe(graph.nodes[1]);
  });

  it("returns the input arrays on an ungrouped overview", () => {
    const input = { nodes: [step("x", 0, 0)], edges: [] };
    const graph = overviewCanvasGraph(input);
    expect(graph.nodes).toBe(input.nodes);
    expect(graph.edges).toBe(input.edges);
  });

  it("paints draggable members at their stored local positions", () => {
    const graph = focused();
    expect(graph.nodes.some((node) => node.id === "g")).toBe(false);
    for (const member of nodes.filter((node) => node.parentId)) {
      const painted = graph.nodes.find((node) => node.id === member.id);
      expect(painted?.position).toBe(member.position);
      expect(painted).not.toHaveProperty("parentId");
      expect(painted).not.toHaveProperty("extent");
      expect(painted).not.toHaveProperty("draggable");
      expect(painted).toMatchObject({
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
      });
      expect(graph.projectedNodeIds.has(member.id)).toBe(false);
    }
    expect(
      graph.edges.map((edge) => [edge.id, edge.source, edge.target])
    ).toEqual([
      ["ab", "a", "b"],
      ["in", ingress(), "a"],
      ["out", "b", continuation()],
    ]);
  });

  it("centres ingress above its topmost target and continuation below its lowest source", () => {
    const graph = focused(nodes, [
      ...edges,
      { id: "in-b", source: "before", target: "b" },
      { id: "out-a", source: "a", target: "after" },
    ]);
    expect(position(graph, ingress())).toEqual({
      x: 162,
      y: 48 - RANK_SPACING - 40,
    });
    expect(position(graph, continuation())).toEqual({
      x: 162,
      y: 260 + WORKFLOW_NODE_HEIGHT + RANK_SPACING,
    });
    expect(
      graph.nodes.filter((node) => node.type === "groupIngress")
    ).toHaveLength(1);
    expect(
      graph.nodes.filter((node) => node.type === "groupContinuation")
    ).toHaveLength(1);
  });

  it("changes neither member position when an edge changes", () => {
    const before = structuredClone(nodes);
    const graph = focused(nodes, [edges[0]!]);
    expect(position(graph, "a")).toEqual(position(focused(), "a"));
    expect(position(graph, "b")).toEqual(position(focused(), "b"));
    expect(nodes).toEqual(before);
  });

  it("ignores frame movement but follows a dragged member", () => {
    const first = focused();
    const movedFrame = focused(
      nodes.map((node) =>
        node.id === "g" ? { ...node, position: { x: 4000, y: -900 } } : node
      )
    );
    expect(movedFrame.nodes).toEqual(first.nodes);
    const movedMember = focused(
      nodes.map((node) =>
        node.id === "b" ? { ...node, position: { x: 720, y: 800 } } : node
      )
    );
    expect(position(movedMember, "b")).toEqual({ x: 720, y: 800 });
    expect(position(movedMember, "a")).toEqual(position(first, "a"));
    expect(position(movedMember, continuation())).toEqual({
      x: 720,
      y: 800 + WORKFLOW_NODE_HEIGHT + RANK_SPACING,
    });
  });

  it("shares one bend for edges entering the same row without routing fragments", () => {
    const graph = focused(
      [...nodes, step("c", 600, 500, "g")],
      [
        ...edges,
        { id: "ac", source: "a", target: "c" },
        { id: "bc", source: "b", target: "c" },
      ]
    );
    const ac = graph.edges.find((edge) => edge.id === "ac");
    const bc = graph.edges.find((edge) => edge.id === "bc");
    expect(ac?.data?.centerY).toBe((260 + WORKFLOW_NODE_HEIGHT + 500) / 2);
    expect(bc?.data?.centerY).toBe(ac?.data?.centerY);
    expect(ac?.data).not.toHaveProperty("drawn");
  });

  it("keeps node and edge identity across unchanged repaints", () => {
    const first = focused();
    const second = focused([...nodes], [...edges]);
    second.nodes.forEach((node, index) =>
      expect(node).toBe(first.nodes[index])
    );
    second.edges.forEach((edge, index) =>
      expect(edge).toBe(first.edges[index])
    );
  });

  it("labels outside Condition outlets separately", () => {
    const graph = focused(nodes, [
      { id: "true", source: "before", sourceHandle: "true", target: "a" },
      { id: "false", source: "before", sourceHandle: "false", target: "b" },
    ]);
    expect(
      graph.nodes
        .filter((node) => node.type === "groupIngress")
        .map((node) => node.id)
    ).toEqual([ingress("before", "true"), ingress("before", "false")]);
    expect(
      graph.edges
        .filter((edge) => ["true", "false"].includes(edge.id))
        .map((edge) => edge.data?.displayLabel)
    ).toEqual(["True", "False"]);
  });

  it("ends an unconnected Condition branch below its source, preserving its label and inert stub", () => {
    const conditionNodes = nodes.map((node) =>
      node.id === "a"
        ? {
            ...node,
            data: {
              ...node.data,
              config: { actionType: BUILT_IN_ACTION_IDS.condition },
            },
          }
        : node
    );
    const graph = focused(
      conditionNodes,
      edges.map((edge) =>
        edge.id === "ab" ? { ...edge, sourceHandle: "true" } : edge
      )
    );
    const stub = graph.nodes.find((node) => node.id === end("a", "false"));
    expect(stub).toMatchObject({
      selectable: false,
      draggable: false,
      deletable: false,
      connectable: false,
      data: { label: "Path ends" },
    });
    expect(stub?.position).toEqual({
      x: 12,
      y: 48 + WORKFLOW_NODE_HEIGHT + RANK_SPACING,
    });
    const endEdge = graph.edges.find((edge) => edge.target === stub?.id);
    expect(resolveEdgeLabel(endEdge?.sourceHandle, endEdge?.data)).toBe(
      "False"
    );
    expect(endEdge).toMatchObject({
      selectable: false,
      deletable: false,
      data: { insertable: false },
    });
    expect(
      storedCanvasConnection({ source: stub!.id, target: "b" }, graph.nodes)
    ).toHaveProperty("refusal");
  });

  it.each([
    "condition",
    "false continuation",
    "multiple targets",
    "two ends",
    "staggered ends",
  ])("separates boundary stubs for %s before and after Tidy", (scenario) => {
    let stored = [
      frame,
      step("a", 0, 0, "g"),
      step("b", 0, 240, "g"),
      step("after", 400, 900),
      step("other", 700, 900),
    ];
    const storedEdges: WorkflowEdge[] =
      scenario === "staggered ends"
        ? []
        : [{ id: "ab", source: "a", target: "b" }];
    if (
      scenario === "condition" ||
      scenario === "false continuation" ||
      scenario === "two ends"
    ) {
      stored = stored.map((node) =>
        node.id === "b"
          ? {
              ...node,
              data: {
                ...node.data,
                config: { actionType: BUILT_IN_ACTION_IDS.condition },
              },
            }
          : node
      );
    }
    if (
      scenario === "condition" ||
      scenario === "false continuation" ||
      scenario === "multiple targets"
    )
      storedEdges.push({
        id: "out",
        source: "b",
        sourceHandle:
          scenario === "condition"
            ? "true"
            : scenario === "false continuation"
              ? "false"
              : null,
        target: "after",
      });
    if (scenario === "multiple targets")
      storedEdges.push({ id: "other", source: "b", target: "other" });
    if (scenario === "staggered ends")
      stored = stored.map((node) =>
        node.id === "b" ? { ...node, position: { x: 12, y: 20 } } : node
      );
    for (let pass = 0; pass < 2; pass++) {
      const graph = focused(stored, storedEdges);
      const stubs = graph.nodes.filter((node) =>
        graph.projectedNodeIds.has(node.id)
      );
      expect(stubs).toHaveLength(2);
      expect(
        rectanglesOverlap(
          { ...stubs[0]!.position, width: WORKFLOW_NODE_WIDTH, height: 40 },
          { ...stubs[1]!.position, width: WORKFLOW_NODE_WIDTH, height: 40 }
        )
      ).toBe(false);
      if (
        scenario === "condition" ||
        scenario === "false continuation" ||
        scenario === "two ends"
      ) {
        const trueTarget = graph.edges.find(
          (edge) => edge.source === "b" && edge.sourceHandle === "true"
        )!.target;
        const falseTarget = graph.edges.find(
          (edge) => edge.source === "b" && edge.sourceHandle === "false"
        )!.target;
        expect(position(graph, trueTarget)!.x).toBeLessThan(
          position(graph, falseTarget)!.x
        );
      }
      for (const member of stored.filter((node) => node.parentId === "g"))
        expect(position(graph, member.id)).toBe(member.position);
      const again = focused(stored, storedEdges);
      graph.nodes.forEach((node, index) =>
        expect(again.nodes[index]).toBe(node)
      );
      const laidOut = layoutWorkflowNodes({
        ...graph,
        catalog: emptyExtensionCatalog,
      });
      stored = stored.map((node) =>
        node.parentId === "g"
          ? {
              ...node,
              position: laidOut.nodes.find((item) => item.id === node.id)!
                .position,
            }
          : node
      );
    }
  });

  it("keeps distinct end stubs for builder-chosen ids including separators", () => {
    const ids = ["\ud800", "x/y", "x", "x%2Fy", "constructor", "__proto__"];
    const graph = focused(
      [frame, ...ids.map((id, index) => step(id, index * 300, 0, "g"))],
      []
    );
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(
      graph.nodes.length
    );
    expect(
      graph.nodes
        .filter((node) => node.type === "groupEnd")
        .map((node) => node.id)
    ).toEqual(ids.map((id) => end(id)));
  });

  it("returns null for a missing Group and recovers its scope to the overview", () => {
    expect(
      focusedGroupCanvasGraph({ nodes, edges, groupId: "missing" })
    ).toBeNull();
    expect(
      scopeCanvasGraph({
        nodes,
        edges,
        scope: { kind: "group", groupId: "missing" },
      }).nodes.map((node) => node.id)
    ).toContain("g");
  });
});

describe("storedCanvasConnection", () => {
  const painted = focused().nodes;
  it("translates incoming and continuation stubs to their stored ports", () => {
    expect(
      storedCanvasConnection({ source: ingress(), target: "b" }, painted)
    ).toEqual({
      connection: { source: "before", sourceHandle: null, target: "b" },
      throughBoundaryStub: true,
    });
    expect(
      storedCanvasConnection({ source: "a", target: continuation() }, painted)
    ).toEqual({
      connection: { source: "a", target: "after", targetHandle: null },
      throughBoundaryStub: true,
    });
  });
  it("refuses backward stub connections and stub-to-stub connections", () => {
    for (const connection of [
      { source: continuation(), target: "a" },
      { source: "a", target: ingress() },
      { source: ingress(), target: continuation() },
    ]) {
      expect(storedCanvasConnection(connection, painted)).toEqual({
        refusal: "Connect to a step inside the Group.",
      });
    }
  });
  it("leaves member connections and lookalike ids alone", () => {
    const connection = { source: "a", target: "b" };
    expect(storedCanvasConnection(connection, painted)).toEqual({
      connection,
      throughBoundaryStub: false,
    });
    const lookalike = { source: ingress(), target: "b" };
    expect(storedCanvasConnection(lookalike, [step(ingress(), 0, 0)])).toEqual({
      connection: lookalike,
      throughBoundaryStub: false,
    });
  });
});

it("filters only stub measurements, preserving member drags and measurements", () => {
  const changes: NodeChange<WorkflowNode>[] = [
    { type: "dimensions", id: ingress(), dimensions: { width: 1, height: 1 } },
    { type: "dimensions", id: "a", dimensions: { width: 192, height: 112 } },
    { type: "position", id: "a", position: { x: 30, y: 40 }, dragging: true },
  ];
  expect(
    withoutProjectedDimensions(changes, focused().projectedNodeIds)
  ).toEqual(changes.slice(1));
  expect(withoutProjectedDimensions(changes, new Set())).toBe(changes);
});
