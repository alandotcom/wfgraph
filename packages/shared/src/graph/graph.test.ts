import { describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "#src/graph/graph";
import type { WorkflowGraphNodeInput } from "#src/graph/graph";

function step(id: string): WorkflowGraphNodeInput {
  return {
    id,
    position: { x: 0, y: 0 },
    type: "action",
    data: { label: id, type: "action", config: {} },
  };
}

describe("createSerializedWorkflowGraph", () => {
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
});
