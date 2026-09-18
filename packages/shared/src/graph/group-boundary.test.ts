import { describe, expect, it } from "vitest";
import {
  analyzeGroupBoundary,
  analyzeGroupBoundaryById,
} from "#src/graph/group-boundary";
import type { WorkflowEdge } from "#src/graph/types";

type Node = { id: string; parentId?: string };

function edge(
  id: string,
  source: string,
  target: string,
  handles: { sourceHandle?: string; targetHandle?: string } = {}
): WorkflowEdge {
  return { id, source, target, ...handles };
}

function member(id: string, parentId = "g"): Node {
  return { id, parentId };
}

describe("analyzeGroupBoundaryById", () => {
  it("derives every boundary part of a lookup chain ending on a Condition", () => {
    const nodes: Node[] = [
      { id: "life" },
      { id: "g" },
      member("a"),
      member("b"),
      member("c"),
      { id: "send" },
    ];
    const edges = [
      edge("in", "life", "a", { sourceHandle: "started" }),
      edge("ab", "a", "b"),
      edge("bc", "b", "c"),
      edge("out", "c", "send", { sourceHandle: "true" }),
    ];

    expect(analyzeGroupBoundaryById({ nodes, edges, groupId: "g" })).toEqual({
      memberIds: ["a", "b", "c"],
      interiorEdges: [edges[1], edges[2]],
      ingressEdges: [edges[0]],
      continuationEdges: [edges[3]],
      externalIngress: [{ nodeId: "life", handle: "started" }],
      internalEntryPorts: [{ nodeId: "a", handle: null }],
      internalContinuation: [{ nodeId: "c", handle: "true" }],
      externalTargets: [{ nodeId: "send", handle: null }],
    });
  });

  it("names one external source port that fans out onto two entry ports", () => {
    const nodes: Node[] = [{ id: "life" }, member("a"), member("b")];
    const edges = [
      edge("in-a", "life", "a", { sourceHandle: "started" }),
      edge("in-b", "life", "b", { sourceHandle: "started" }),
    ];

    const boundary = analyzeGroupBoundaryById({ nodes, edges, groupId: "g" });

    expect(boundary.externalIngress).toEqual([
      { nodeId: "life", handle: "started" },
    ]);
    expect(boundary.internalEntryPorts).toEqual([
      { nodeId: "a", handle: null },
      { nodeId: "b", handle: null },
    ]);
  });

  it("names one continuation port that reaches two external targets", () => {
    const nodes: Node[] = [member("a"), member("b"), { id: "x" }, { id: "y" }];
    const edges = [
      edge("ab", "a", "b"),
      edge("bx", "b", "x", { targetHandle: "input" }),
      edge("by", "b", "y"),
    ];

    const boundary = analyzeGroupBoundaryById({ nodes, edges, groupId: "g" });

    expect(boundary.internalContinuation).toEqual([
      { nodeId: "b", handle: null },
    ]);
    expect(boundary.externalTargets).toEqual([
      { nodeId: "x", handle: "input" },
      { nodeId: "y", handle: null },
    ]);
  });

  it("names the continuing member port beside a member whose path ends inside", () => {
    const nodes: Node[] = [
      member("cond"),
      member("lookup"),
      member("dead-end"),
      { id: "send" },
    ];
    const edges = [
      edge("t", "cond", "lookup", { sourceHandle: "true" }),
      edge("f", "cond", "dead-end", { sourceHandle: "false" }),
      edge("out", "lookup", "send"),
    ];

    const boundary = analyzeGroupBoundaryById({ nodes, edges, groupId: "g" });

    expect(boundary.internalContinuation).toEqual([
      { nodeId: "lookup", handle: null },
    ]);
  });

  it("reads an edge between two Groups as continuation for one and ingress for the other", () => {
    const nodes: Node[] = [
      member("a", "g1"),
      member("b", "g1"),
      member("c", "g2"),
      member("d", "g2"),
    ];
    const edges = [
      edge("ab", "a", "b"),
      edge("bc", "b", "c"),
      edge("cd", "c", "d"),
    ];

    const first = analyzeGroupBoundaryById({ nodes, edges, groupId: "g1" });
    const second = analyzeGroupBoundaryById({ nodes, edges, groupId: "g2" });

    expect(first.continuationEdges).toEqual([edges[1]]);
    expect(first.ingressEdges).toEqual([]);
    expect(second.ingressEdges).toEqual([edges[1]]);
    expect(second.continuationEdges).toEqual([]);
  });

  it("answers empty lists for a Group no node names as its parent", () => {
    const boundary = analyzeGroupBoundaryById({
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [edge("ab", "a", "b")],
      groupId: "g",
    });

    expect(boundary.memberIds).toEqual([]);
    expect(boundary.interiorEdges).toEqual([]);
    expect(boundary.ingressEdges).toEqual([]);
    expect(boundary.continuationEdges).toEqual([]);
  });

  it("reads a member id that names a prototype member as an ordinary id", () => {
    const nodes: Node[] = [member("constructor"), member("__proto__")];
    const edges = [edge("e", "constructor", "__proto__")];

    const boundary = analyzeGroupBoundaryById({ nodes, edges, groupId: "g" });

    expect(boundary.interiorEdges).toEqual(edges);
  });
});

describe("analyzeGroupBoundary", () => {
  it("classifies edges for a member set that no node names as a parent yet", () => {
    const edges = [
      edge("in", "life", "a", { sourceHandle: "started" }),
      edge("ab", "a", "b"),
      edge("out", "b", "send"),
      edge("elsewhere", "life", "send"),
    ];

    const boundary = analyzeGroupBoundary({ memberIds: ["a", "b"], edges });

    expect(boundary.memberIds).toEqual(["a", "b"]);
    expect(boundary.interiorEdges).toEqual([edges[1]]);
    expect(boundary.ingressEdges).toEqual([edges[0]]);
    expect(boundary.continuationEdges).toEqual([edges[2]]);
  });
});
