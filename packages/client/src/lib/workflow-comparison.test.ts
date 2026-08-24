import { describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type {
  WorkflowComparisonPayload,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import type {
  WorkflowEdge as PersistedWorkflowEdge,
  WorkflowNode as PersistedWorkflowNode,
} from "@wfgraph/shared/graph/types";
import { buildComparisonDisplayGraph } from "#src/lib/workflow-comparison";
import {
  COMPARISON_EDGE_ANNOTATION,
  COMPARISON_NODE_ANNOTATION,
} from "#src/lib/workflow-graph-types";

function node(id: string, position = { x: 0, y: 0 }): PersistedWorkflowNode {
  return {
    id,
    type: "action",
    position,
    data: { label: id, type: "action" },
  };
}

function payload(input: {
  baseNodes: PersistedWorkflowNode[];
  draftNodes: PersistedWorkflowNode[];
  baseEdges?: PersistedWorkflowEdge[];
  draftEdges?: PersistedWorkflowEdge[];
  nodeChanges?: WorkflowNodeChange[];
  edgeChanges?: WorkflowComparisonPayload["edgeChanges"];
}): WorkflowComparisonPayload {
  return {
    baseVersion: null,
    proposedVersion: 1,
    baseGraph: createSerializedWorkflowGraph({
      nodes: input.baseNodes,
      edges: input.baseEdges ?? [],
    }),
    draftGraph: createSerializedWorkflowGraph({
      nodes: input.draftNodes,
      edges: input.draftEdges ?? [],
    }),
    hasChanges: true,
    nodeChanges: input.nodeChanges ?? [],
    edgeChanges: input.edgeChanges ?? [],
  };
}

describe("buildComparisonDisplayGraph", () => {
  it("reuses the built graph for equivalent position overrides", () => {
    const comparison = payload({
      baseNodes: [node("shared"), node("removed")],
      draftNodes: [node("shared")],
      nodeChanges: [{ nodeId: "removed", kind: "removed", fields: [] }],
    });

    const first = buildComparisonDisplayGraph(comparison, {});
    const second = buildComparisonDisplayGraph(comparison, {});

    expect(second).toBe(first);
  });

  it("merges the draft with removed history and marks only server-reported changes", () => {
    const graph = buildComparisonDisplayGraph(
      payload({
        baseNodes: [node("shared"), node("removed")],
        draftNodes: [node("shared", { x: 100, y: 50 }), node("added")],
        nodeChanges: [
          { nodeId: "added", kind: "added", fields: [] },
          { nodeId: "removed", kind: "removed", fields: [] },
        ],
      })
    );

    expect(graph.nodes.map((item) => item.id)).toEqual([
      "shared",
      "added",
      "removed",
    ]);
    expect(graph.nodes.find((item) => item.id === "shared")?.position).toEqual({
      x: 100,
      y: 50,
    });
    expect(
      graph.nodes.find((item) => item.id === "shared")?.data[
        COMPARISON_NODE_ANNOTATION
      ]
    ).toBeUndefined();
    expect(
      graph.nodes.find((item) => item.id === "added")?.data[
        COMPARISON_NODE_ANNOTATION
      ]?.kind
    ).toBe("added");
    expect(
      graph.nodes.find((item) => item.id === "removed")?.data[
        COMPARISON_NODE_ANNOTATION
      ]?.kind
    ).toBe("removed");
  });

  it("flattens a removed child when its historical parent remains in the draft", () => {
    const group: PersistedWorkflowNode = {
      ...node("group", { x: 100, y: 200 }),
      type: "group",
      data: {
        label: "Group",
        type: "group",
        config: { entryNodeIds: [], exitNodeIds: [] },
      },
    };
    const child = { ...node("removed", { x: 20, y: 30 }), parentId: "group" };
    const graph = buildComparisonDisplayGraph(
      payload({
        baseNodes: [group, child, node("target")],
        draftNodes: [group, node("target")],
        nodeChanges: [{ nodeId: "removed", kind: "removed", fields: [] }],
      })
    );

    expect(graph.nodes.find((item) => item.id === "removed")).toMatchObject({
      parentId: undefined,
      position: { x: 120, y: 230 },
      draggable: true,
      focusable: true,
      deletable: false,
    });
  });

  it("keeps a deleted child relative to its deleted parent and orders the parent first", () => {
    const group: PersistedWorkflowNode = {
      ...node("group", { x: 100, y: 200 }),
      type: "group",
      data: {
        label: "Group",
        type: "group",
        config: { entryNodeIds: ["child"], exitNodeIds: ["child"] },
      },
    };
    const child = { ...node("child", { x: 20, y: 30 }), parentId: "group" };

    const graph = buildComparisonDisplayGraph(
      payload({
        baseNodes: [child, group, node("target")],
        draftNodes: [node("target")],
        baseEdges: [{ id: "edge", source: "child", target: "target" }],
        nodeChanges: [
          { nodeId: "group", kind: "removed", fields: [] },
          { nodeId: "child", kind: "removed", fields: [] },
        ],
        edgeChanges: [{ edgeId: "edge", kind: "removed" }],
      }),
      { group: { x: 500, y: 600 } }
    );

    expect(graph.nodes.map((item) => item.id)).toEqual([
      "target",
      "group",
      "child",
    ]);
    expect(graph.nodes.find((item) => item.id === "group")).toMatchObject({
      position: { x: 500, y: 600 },
      draggable: true,
    });
    expect(graph.nodes.find((item) => item.id === "child")).toMatchObject({
      parentId: "group",
      position: { x: 20, y: 30 },
      draggable: true,
      focusable: true,
    });
  });

  it("freezes draft nodes and all comparison edges while retaining deleted-node movement", () => {
    const graph = buildComparisonDisplayGraph(
      payload({
        baseNodes: [node("shared"), node("deleted")],
        draftNodes: [node("shared"), node("added")],
        baseEdges: [{ id: "removed", source: "shared", target: "deleted" }],
        draftEdges: [{ id: "added", source: "shared", target: "added" }],
        nodeChanges: [
          { nodeId: "deleted", kind: "removed", fields: [] },
          { nodeId: "added", kind: "added", fields: [] },
        ],
        edgeChanges: [
          { edgeId: "removed", kind: "removed" },
          { edgeId: "added", kind: "added" },
        ],
      })
    );

    expect(graph.nodes.find((item) => item.id === "shared")).toMatchObject({
      draggable: false,
      focusable: false,
      deletable: false,
    });
    expect(graph.nodes.find((item) => item.id === "deleted")).toMatchObject({
      draggable: true,
      focusable: true,
      deletable: false,
    });
    expect(
      graph.edges.every(
        (edge) => edge.focusable === false && edge.deletable === false
      )
    ).toBe(true);
  });

  it("renders an unchanged semantic edge only from the draft when its id changes", () => {
    const graph = buildComparisonDisplayGraph(
      payload({
        baseNodes: [node("source"), node("target")],
        draftNodes: [node("source"), node("target")],
        baseEdges: [{ id: "old-id", source: "source", target: "target" }],
        draftEdges: [{ id: "new-id", source: "source", target: "target" }],
      })
    );

    expect(graph.edges.map((edge) => edge.id)).toEqual(["new-id"]);
  });

  it("gives same-id removed and added edges distinct display ids", () => {
    const graph = buildComparisonDisplayGraph(
      payload({
        baseNodes: [node("source"), node("target")],
        draftNodes: [node("source"), node("target")],
        baseEdges: [{ id: "edge", source: "source", target: "target" }],
        draftEdges: [{ id: "edge", source: "target", target: "source" }],
        edgeChanges: [
          { edgeId: "edge", kind: "removed" },
          { edgeId: "edge", kind: "added" },
        ],
      })
    );

    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(2);
    expect(graph.edges.map((edge) => edge.id)).toContain("edge");
    expect(
      graph.edges.map((edge) => edge.data?.[COMPARISON_EDGE_ANNOTATION])
    ).toEqual(
      expect.arrayContaining([
        { kind: "added", sourceId: "edge" },
        { kind: "removed", sourceId: "edge" },
      ])
    );
  });

  it("allocates synthetic ids around adversarial real ids", () => {
    const graph = buildComparisonDisplayGraph(
      payload({
        baseNodes: [node("source"), node("target")],
        draftNodes: [node("source"), node("target")],
        baseEdges: [{ id: "edge", source: "source", target: "target" }],
        draftEdges: [
          { id: "edge", source: "target", target: "source" },
          {
            id: "comparison:removed:edge",
            source: "source",
            target: "target",
          },
        ],
        edgeChanges: [
          { edgeId: "edge", kind: "removed" },
          { edgeId: "edge", kind: "added" },
        ],
      })
    );

    expect(graph.edges.map((edge) => edge.id)).toEqual([
      "edge",
      "comparison:removed:edge",
      "comparison:removed:edge:1",
    ]);
  });
});
