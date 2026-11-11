import { describe, expect, it } from "vitest";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { placeNewWorkflowNodes } from "#src/graph/workflow-placement";
import {
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
} from "#src/graph/workflow-layout-geometry";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  actions: [],
  integrations: [],
};

function step(id: string, x: number, y: number): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x, y },
    data: { label: id, type: "action", config: { actionType: "Wait" } },
  };
}

function edge(source: string, target: string): WorkflowEdge {
  return { id: `${source}-${target}`, source, target };
}

describe("placeNewWorkflowNodes", () => {
  it("keeps hand-placed steps and puts a new step below its source", () => {
    const nodes = [step("a", 300, 40), step("b", 900, 500), step("new", 0, 0)];

    const placed = placeNewWorkflowNodes({
      nodes,
      edges: [edge("a", "b"), edge("a", "new")],
      catalog,
      unplacedIds: new Set(["new"]),
    });

    expect(placed[0]).toBe(nodes[0]);
    expect(placed[1]).toBe(nodes[1]);
    expect(placed[2]?.position).toEqual({
      x: 300,
      y: 40 + WORKFLOW_NODE_HEIGHT + RANK_SPACING,
    });
  });

  it("moves a new step right of a sibling already in its slot", () => {
    const below = 40 + WORKFLOW_NODE_HEIGHT + RANK_SPACING;
    const nodes = [
      step("a", 300, 40),
      step("b", 300, below),
      step("new", 0, 0),
    ];

    const placed = placeNewWorkflowNodes({
      nodes,
      edges: [edge("a", "b"), edge("a", "new")],
      catalog,
      unplacedIds: new Set(["new"]),
    });

    expect(placed[2]?.position.y).toBe(below);
    expect(placed[2]?.position.x).toBeGreaterThan(300);
  });

  it("places a chain of new steps from the arranged end, never stacking them", () => {
    const nodes = [step("a", 300, 40), step("n1", 0, 0), step("n2", 0, 0)];

    const placed = placeNewWorkflowNodes({
      nodes,
      edges: [edge("a", "n1"), edge("n1", "n2")],
      catalog,
      unplacedIds: new Set(["n1", "n2"]),
    });

    const [, first, second] = placed;
    expect(first?.position.y).toBeGreaterThan(40);
    expect(second?.position.y).toBeGreaterThan(first?.position.y ?? 0);
  });

  it("lays out the whole graph when nothing has a position yet", () => {
    const nodes = [step("a", 0, 0), step("n1", 0, 0)];

    const placed = placeNewWorkflowNodes({
      nodes,
      edges: [edge("a", "n1")],
      catalog,
      unplacedIds: new Set(["n1"]),
    });

    expect(placed[0]?.position).not.toEqual(placed[1]?.position);
  });

  it("returns the nodes unchanged when none is unplaced", () => {
    const nodes = [step("a", 300, 40)];

    expect(
      placeNewWorkflowNodes({
        nodes,
        edges: [],
        catalog,
        unplacedIds: new Set(),
      })
    ).toBe(nodes);
  });
});
