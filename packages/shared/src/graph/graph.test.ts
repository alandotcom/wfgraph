import { describe, expect, it } from "vitest";
import {
  createSerializedWorkflowGraph,
  parseWorkflowGraphData,
  serializeWorkflowGraphData,
  toWorkflowGraphData,
} from "#src/graph/graph";
import type { WorkflowNode } from "#src/graph/types";

function step(id: string): WorkflowNode {
  return {
    id,
    position: { x: 0, y: 0 },
    type: "action",
    data: { label: id, type: "action", config: {} },
  };
}

describe("serializeWorkflowGraphData", () => {
  it("preserves duplicate node and edge IDs for validation", () => {
    const duplicateNode = step("duplicate-node");
    const duplicateEdge = {
      id: "duplicate-edge",
      source: "duplicate-node",
      target: "target",
    };

    const graph = serializeWorkflowGraphData({
      nodes: [duplicateNode, duplicateNode, step("target")],
      edges: [duplicateEdge, duplicateEdge],
    });

    expect(graph.nodes.map((node) => node.key)).toEqual([
      "duplicate-node",
      "duplicate-node",
      "target",
    ]);
    expect(graph.edges.map((edge) => edge.key)).toEqual([
      "duplicate-edge",
      "duplicate-edge",
    ]);
  });

  it("preserves missing endpoints, self-loops, and parallel edges", () => {
    const edges = [
      { id: "missing", source: "a", target: "gone" },
      { id: "self", source: "a", target: "a" },
      { id: "parallel-1", source: "a", target: "b" },
      { id: "parallel-2", source: "a", target: "b" },
    ];

    const graph = serializeWorkflowGraphData({
      nodes: [step("a"), step("b")],
      edges,
    });

    expect(
      graph.edges.map(({ key, source, target }) => ({
        key,
        source,
        target,
      }))
    ).toEqual(
      edges.map((edge) => ({
        key: edge.id,
        source: edge.source,
        target: edge.target,
      }))
    );
  });
});

describe("createSerializedWorkflowGraph", () => {
  it("enforces self-loop topology", () => {
    expect(() =>
      createSerializedWorkflowGraph({
        nodes: [step("a")],
        edges: [{ id: "self", source: "a", target: "a" }],
      })
    ).toThrow();
  });

  it("refuses a duplicate edge ID used for different endpoints", () => {
    expect(() =>
      createSerializedWorkflowGraph({
        nodes: [step("a"), step("b"), step("c")],
        edges: [
          { id: "duplicate", source: "a", target: "b" },
          { id: "duplicate", source: "a", target: "c" },
        ],
      })
    ).toThrow();
  });

  it("retains graph attributes", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [],
      edges: [],
      attributes: { owner: "workflow" },
    });

    expect(graph.attributes).toEqual({ owner: "workflow" });
  });

  it("names the edge whose end has no node", () => {
    expect(() =>
      createSerializedWorkflowGraph({
        nodes: [step("a")],
        edges: [{ id: "e1", source: "a", target: "gone" }],
      })
    ).toThrow("Edge 'e1' names gone, which the graph has no node for");
  });

  it("keeps an edge whose ends both have nodes", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [step("a"), step("b")],
      edges: [{ id: "e1", source: "a", target: "b" }],
    });

    expect(graph.nodes.map((node) => node.key)).toEqual(["a", "b"]);
    expect(graph.edges.map((edge) => edge.key)).toEqual(["e1"]);
  });

  it("omits enabled: true because a missing key is already on", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        {
          ...step("on"),
          data: { ...step("on").data, enabled: true },
        },
        {
          ...step("off"),
          data: { ...step("off").data, enabled: false },
        },
      ],
      edges: [],
    });

    expect(graph.nodes[0]?.attributes.data.enabled).toBeUndefined();
    expect(graph.nodes[1]?.attributes.data.enabled).toBe(false);
  });

  it("drops a stored enabled: true when reading a graph", () => {
    const omitted = createSerializedWorkflowGraph({
      nodes: [step("a")],
      edges: [],
    });
    const storedOn = {
      ...omitted,
      nodes: omitted.nodes.map((node) => ({
        ...node,
        attributes: {
          ...node.attributes,
          data: { ...node.attributes.data, enabled: true },
        },
      })),
    };

    expect(
      toWorkflowGraphData(storedOn).nodes[0]?.data.enabled
    ).toBeUndefined();
  });
});

describe("parseWorkflowGraphData", () => {
  it("round-trips supported node and edge fields", () => {
    const graph = toWorkflowGraphData(
      serializeWorkflowGraphData({
        nodes: [
          {
            ...step("action"),
            parentId: "group",
            width: 200,
            height: 120,
            measured: { width: 192, height: 112 },
            data: {
              ...step("action").data,
              description: "Sends an email",
              enabled: false,
            },
          },
          step("group"),
        ],
        edges: [
          {
            id: "edge",
            source: "group",
            target: "action",
            sourceHandle: "out",
            targetHandle: "in",
            data: { label: "Continue" },
          },
        ],
      })
    );

    expect(graph).toEqual({
      nodes: [
        {
          id: "action",
          position: { x: 0, y: 0 },
          type: "action",
          parentId: "group",
          width: 200,
          height: 120,
          measured: { width: 192, height: 112 },
          data: {
            label: "action",
            type: "action",
            description: "Sends an email",
            enabled: false,
            config: {},
          },
        },
        step("group"),
      ],
      edges: [
        {
          id: "edge",
          source: "group",
          target: "action",
          sourceHandle: "out",
          targetHandle: "in",
          data: { label: "Continue" },
        },
      ],
    });
  });

  it("preserves duplicate node and edge IDs", () => {
    const duplicateNode = step("duplicate-node");
    const duplicateEdge = {
      id: "duplicate-edge",
      source: "duplicate-node",
      target: "duplicate-node",
    };

    const graph = parseWorkflowGraphData({
      nodes: [duplicateNode, duplicateNode],
      edges: [duplicateEdge, duplicateEdge],
    });

    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(2);
  });

  it("returns canonical nodes after accepting editor and run overlays", () => {
    const graph = parseWorkflowGraphData({
      nodes: [
        {
          ...step("action"),
          selected: true,
          dragging: true,
          onClick: "editor callback placeholder",
          data: {
            ...step("action").data,
            status: "running",
            onClick: "editor callback placeholder",
          },
        },
      ],
      edges: [],
    });

    expect(graph.nodes).toEqual([step("action")]);
  });
});
