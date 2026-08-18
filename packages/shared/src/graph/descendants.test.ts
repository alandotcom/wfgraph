import { describe, expect, it } from "vitest";
import { descendantsOf } from "#src/graph/descendants";
import type { WorkflowEdge } from "#src/graph/types";

function edge(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target };
}

describe("descendantsOf", () => {
  it("answers with everything an edge path leads to", () => {
    const edges = [
      edge("e1", "a", "b"),
      edge("e2", "b", "c"),
      edge("e3", "x", "y"),
    ];

    expect([...descendantsOf({ startIds: ["a"], edges })].sort()).toEqual([
      "b",
      "c",
    ]);
  });

  // The caller draws the start node's own face, so it must not come back as one
  // of the nodes below it.
  it("leaves the start node out", () => {
    const edges = [edge("e1", "a", "b")];

    expect(descendantsOf({ startIds: ["a"], edges }).has("a")).toBe(false);
  });

  it("terminates on a cycle, and names the start that the cycle returns to", () => {
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "a")];

    expect([...descendantsOf({ startIds: ["a"], edges })].sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("takes several starts at once", () => {
    const edges = [edge("e1", "a", "b"), edge("e2", "x", "y")];

    expect([...descendantsOf({ startIds: ["a", "x"], edges })].sort()).toEqual([
      "b",
      "y",
    ]);
  });
});
