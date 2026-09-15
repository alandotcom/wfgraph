import { describe, expect, it } from "vitest";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { graphDigest } from "#src/backend/services/workflows/version-digest";

function lookup(id: string, parentId?: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    parentId,
    data: {
      label: id,
      type: "action",
      config: { actionType: "custom/lookup" },
    },
  };
}

const frame: WorkflowNode = {
  id: "group-1",
  type: "group",
  position: { x: 0, y: 200 },
  width: 212,
  height: 180,
  data: { label: "Lookups", type: "group" },
};

const edges: WorkflowEdge[] = [
  { id: "ab", source: "a", target: "b" },
  { id: "bc", source: "b", target: "c" },
];

function groupedGraph() {
  return createSerializedWorkflowGraph({
    nodes: [frame, lookup("a", "group-1"), lookup("b", "group-1"), lookup("c")],
    edges,
  });
}

describe("graphDigest with a Group", () => {
  it("hashes a Group alike after a decode and encode round trip", () => {
    const graph = groupedGraph();
    const roundTripped = createSerializedWorkflowGraph(
      toWorkflowGraphData(graph)
    );

    expect(graphDigest(roundTripped)).toBe(graphDigest(graph));
  });

  it("ignores the frame's and members' geometry", () => {
    const moved = createSerializedWorkflowGraph({
      nodes: [
        { ...frame, position: { x: 400, y: 900 }, width: 500 },
        { ...lookup("a", "group-1"), position: { x: 30, y: 60 } },
        lookup("b", "group-1"),
        lookup("c"),
      ],
      edges,
    });

    expect(graphDigest(moved)).toBe(graphDigest(groupedGraph()));
  });

  it("changes when membership changes", () => {
    const ungrouped = createSerializedWorkflowGraph({
      nodes: [lookup("a"), lookup("b"), lookup("c")],
      edges,
    });
    const regrouped = createSerializedWorkflowGraph({
      nodes: [
        frame,
        lookup("a", "group-1"),
        lookup("b"),
        lookup("c", "group-1"),
      ],
      edges,
    });

    expect(graphDigest(ungrouped)).not.toBe(graphDigest(groupedGraph()));
    expect(graphDigest(regrouped)).not.toBe(graphDigest(groupedGraph()));
  });

  it("changes when an executable edge changes", () => {
    const rewired = createSerializedWorkflowGraph({
      nodes: [
        frame,
        lookup("a", "group-1"),
        lookup("b", "group-1"),
        lookup("c"),
      ],
      edges: [
        { id: "ab", source: "a", target: "b" },
        { id: "ac", source: "a", target: "c" },
      ],
    });

    expect(graphDigest(rewired)).not.toBe(graphDigest(groupedGraph()));
  });
});
