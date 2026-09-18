import { describe, expect, it } from "vitest";
import {
  graphInScope,
  graphStructureKey,
  groupScopeExists,
  scopeOfEdge,
  scopeOfNode,
} from "#src/lib/workflow-scope-graph";

const graph = {
  nodes: [
    { id: "trigger", data: { type: "lifecycle" } },
    { id: "group_1", data: { type: "group" } },
    { id: "child", parentId: "group_1", data: { type: "action" } },
  ],
  edges: [{ id: "trigger-group_1", target: "child" }],
};

describe("workspace scopes of a graph", () => {
  it("limits a scope to what it shows: members and the edges entering them on a Group, the rest on the overview", () => {
    expect(
      graphInScope(graph, { kind: "overview" }).nodes.map((node) => node.id)
    ).toEqual(["trigger", "group_1"]);
    expect(graphInScope(graph, { kind: "overview" }).edges).toBe(graph.edges);
    expect(graphInScope(graph, { kind: "group", groupId: "group_1" })).toEqual({
      nodes: [graph.nodes[2]],
      edges: graph.edges,
    });
    const flat = { nodes: [graph.nodes[0]], edges: [] };
    expect(graphInScope(flat, { kind: "overview" })).toBe(flat);
  });

  it("names the scope that shows a node", () => {
    expect(scopeOfNode(graph.nodes, "child")).toEqual({
      kind: "group",
      groupId: "group_1",
    });
    expect(scopeOfNode(graph.nodes, "trigger")).toEqual({ kind: "overview" });
    expect(scopeOfNode(graph.nodes, "gone")).toEqual({ kind: "overview" });
  });

  it("names the Group scope for an edge between two members of that Group alone", () => {
    const nodes = [
      ...graph.nodes,
      { id: "sibling", parentId: "group_1", data: { type: "action" } },
      { id: "group_2", data: { type: "group" } },
      { id: "other", parentId: "group_2", data: { type: "action" } },
    ];
    expect(scopeOfEdge(nodes, { source: "child", target: "sibling" })).toEqual({
      kind: "group",
      groupId: "group_1",
    });
    expect(scopeOfEdge(nodes, { source: "trigger", target: "child" })).toEqual({
      kind: "overview",
    });
    expect(scopeOfEdge(nodes, { source: "child", target: "other" })).toEqual({
      kind: "overview",
    });
  });

  it("accepts a focused scope only for a Group node", () => {
    expect(groupScopeExists({ kind: "group", groupId: "group_1" }, graph)).toBe(
      true
    );
    expect(groupScopeExists({ kind: "group", groupId: "child" }, graph)).toBe(
      false
    );
    expect(groupScopeExists({ kind: "overview" }, graph)).toBe(true);
  });

  it("keys structure on ids, kinds, and parents and ignores positions", () => {
    const moved = {
      ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, position: { x: 9, y: 9 } })),
    };
    expect(graphStructureKey(moved)).toBe(graphStructureKey(graph));
    expect(
      graphStructureKey({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === "child" ? { ...node, parentId: undefined } : node
        ),
      })
    ).not.toBe(graphStructureKey(graph));
  });
});
