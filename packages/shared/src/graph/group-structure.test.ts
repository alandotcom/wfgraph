import { describe, expect, it } from "vitest";
import { groupStructureRefusalReason } from "#src/graph/group-structure";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { workflowTopologyRefusalReason } from "#src/graph/workflow-topology";

function lifecycle(): WorkflowNode {
  return {
    id: "life",
    position: { x: 0, y: 0 },
    data: { label: "Lifecycle", type: "lifecycle", config: {} },
  };
}

function frame(id = "g", parentId?: string): WorkflowNode {
  return {
    id,
    type: "group",
    position: { x: 0, y: 0 },
    data: { label: `Frame ${id}`, type: "group" },
    parentId,
  };
}

function lookup(id: string, parentId?: string): WorkflowNode {
  return {
    id,
    position: { x: 0, y: 0 },
    data: {
      label: `Lookup ${id}`,
      type: "action",
      config: { actionType: "fountain/get-user" },
    },
    parentId,
  };
}

function edge(id: string, source: string, target: string): WorkflowEdge {
  return source === "life"
    ? { id, source, target, sourceHandle: "started" }
    : { id, source, target };
}

/** Lifecycle, then a Group of two lookups, then a lookup outside it. */
function validGraph(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: [
      lifecycle(),
      frame(),
      lookup("a", "g"),
      lookup("b", "g"),
      lookup("after"),
    ],
    edges: [
      edge("in", "life", "a"),
      edge("ab", "a", "b"),
      edge("out", "b", "after"),
    ],
  };
}

describe("groupStructureRefusalReason", () => {
  it("accepts a Group whose members name it and whose edges name members", () => {
    expect(groupStructureRefusalReason(validGraph())).toBeNull();
    expect(workflowTopologyRefusalReason(validGraph())).toBeNull();
  });

  it("refuses a member whose parent is missing", () => {
    const graph = validGraph();
    graph.nodes = graph.nodes.filter((node) => node.id !== "g");

    expect(groupStructureRefusalReason(graph)).toBe(
      'Node "Lookup a" names a parent Group the graph does not contain'
    );
  });

  it("refuses a parent that is not a Group", () => {
    const graph = validGraph();
    graph.nodes = [...graph.nodes, lookup("child", "after")];

    expect(groupStructureRefusalReason(graph)).toBe(
      'Node "Lookup child" names a parent that is not a Group'
    );
  });

  it("refuses a Group nested inside another Group", () => {
    const graph = validGraph();
    graph.nodes = [...graph.nodes, frame("inner", "g")];

    expect(groupStructureRefusalReason(graph)).toBe(
      'Group "Frame inner" cannot sit inside another Group'
    );
  });

  it("refuses the Lifecycle Node as a member", () => {
    const graph = validGraph();
    graph.nodes = graph.nodes.map((node) =>
      node.id === "life" ? { ...node, parentId: "g" } : node
    );

    expect(groupStructureRefusalReason(graph)).toBe(
      'Node "Lifecycle" cannot be a member of Group "Frame g", because only action steps can be Group members'
    );
  });

  it("refuses an editor Add node as a member", () => {
    const graph = validGraph();
    graph.nodes = [
      ...graph.nodes,
      {
        id: "add",
        type: "add",
        position: { x: 0, y: 0 },
        parentId: "g",
        data: { label: "Add", type: "add" },
      },
    ];

    expect(groupStructureRefusalReason(graph)).toBe(
      'Node "Add" cannot be a member of Group "Frame g", because only action steps can be Group members'
    );
  });

  it("refuses a stored edge that targets a Group frame", () => {
    const graph = validGraph();
    graph.edges = [...graph.edges, edge("into-frame", "after", "g")];

    expect(groupStructureRefusalReason(graph)).toBe(
      'Edge "into-frame" connects to Group "Frame g". Connect a step inside the Group.'
    );
  });

  it("refuses a stored edge that leaves a Group frame", () => {
    const graph = validGraph();
    graph.edges = [...graph.edges, edge("from-frame", "g", "after")];

    expect(groupStructureRefusalReason(graph)).toBe(
      'Edge "from-frame" connects to Group "Frame g". Connect a step inside the Group.'
    );
  });

  it("is part of the topology policy every save runs", () => {
    const graph = validGraph();
    graph.edges = [...graph.edges, edge("from-frame", "g", "after")];

    expect(workflowTopologyRefusalReason(graph)).toBe(
      'Edge "from-frame" connects to Group "Frame g". Connect a step inside the Group.'
    );
  });
});
