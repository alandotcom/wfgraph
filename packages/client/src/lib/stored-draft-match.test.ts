import { describe, expect, it } from "vitest";
import { storedDraftHoldsGraph } from "#src/lib/stored-draft-match";
import { toEditorGraph, toSerializedGraph } from "#src/lib/rpc-client";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";

function actionNode(id: string, x = 0): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x, y: 0 },
    data: {
      label: id,
      type: "action",
      config: { actionType: "custom/send-message" },
    },
  };
}

const edges: WorkflowEdge[] = [{ id: "a-b", source: "a", target: "b" }];

/** What a load of the stored graph hands back, as `toSavedWorkflow` builds it. */
function stored(graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }) {
  return {
    ...savedWorkflow("workflow_1"),
    ...toEditorGraph(toSerializedGraph(graph)),
  };
}

describe("storedDraftHoldsGraph", () => {
  it("matches the graph a save sent, whatever the editor kept beside it", () => {
    const sent = {
      nodes: [
        { ...actionNode("a"), selected: true },
        actionNode("b"),
        {
          id: "add_1",
          type: "add",
          position: { x: 0, y: 0 },
          data: { label: "", type: "add" },
        } satisfies WorkflowNode,
      ],
      edges,
    };

    expect(
      storedDraftHoldsGraph(
        stored({ nodes: [actionNode("b"), actionNode("a")], edges }),
        sent
      )
    ).toBe(true);
  });

  it("does not match a graph with a node moved", () => {
    expect(
      storedDraftHoldsGraph(
        stored({ nodes: [actionNode("a", 40), actionNode("b")], edges }),
        { nodes: [actionNode("a"), actionNode("b")], edges }
      )
    ).toBe(false);
  });

  it("does not match a graph with a node's config changed", () => {
    const changed = actionNode("a");
    changed.data = { ...changed.data, config: { actionType: "custom/other" } };

    expect(
      storedDraftHoldsGraph(
        stored({ nodes: [changed, actionNode("b")], edges }),
        {
          nodes: [actionNode("a"), actionNode("b")],
          edges,
        }
      )
    ).toBe(false);
  });

  it("does not match a graph missing an edge", () => {
    expect(
      storedDraftHoldsGraph(
        stored({ nodes: [actionNode("a"), actionNode("b")], edges: [] }),
        { nodes: [actionNode("a"), actionNode("b")], edges }
      )
    ).toBe(false);
  });
});
