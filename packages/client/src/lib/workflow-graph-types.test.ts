import { describe, expect, it } from "vitest";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import type { WorkflowNode as PersistedWorkflowNode } from "@wfgraph/shared/graph/types";
import {
  toEditorEdge,
  toEditorNode,
  toPersistedEdge,
  toPersistedNode,
  workflowNodeAriaLabel,
  WORKFLOW_EDGE_TYPE,
} from "#src/lib/workflow-graph-types";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

function node(id: string): PersistedWorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action" },
  };
}

/**
 * The reload path: what the editor holds is saved, read back from the wire, and
 * turned into editor elements again. A page refresh runs exactly this.
 */
function reload(input: { nodes?: WorkflowNode[]; edges?: WorkflowEdge[] }): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} {
  const graph = createSerializedWorkflowGraph({
    nodes: input.nodes?.map(toPersistedNode) ?? [node("a"), node("b")],
    edges: (input.edges ?? []).map(toPersistedEdge),
  });
  const data = toWorkflowGraphData(graph);
  return {
    nodes: data.nodes.map(toEditorNode),
    edges: data.edges.map(toEditorEdge),
  };
}

function editorNode(id: string, selected: boolean): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    selected,
    dragging: selected,
    data: { label: id, type: "action" },
  };
}

describe("the persist round trip", () => {
  it("gives React Flow a visible node name rather than an internal id", () => {
    expect(toEditorNode(node("Find issues")).ariaLabel).toBe("Find issues");
  });

  it("uses the catalog label for an action with no custom label", () => {
    const action = node("action_1");
    action.data = {
      ...action.data,
      label: "",
      config: { actionType: "linear/find-issues" },
    };

    expect(
      workflowNodeAriaLabel(action.data, {
        events: [],
        integrations: [],
        actions: [
          {
            id: "linear/find-issues",
            label: "Find issues",
            description: "Find matching issues",
            category: "Linear",
            configFields: [],
            outputFields: [],
          },
        ],
      })
    ).toBe("Find issues");
  });

  it("keeps the handle a Condition branch left by", () => {
    const { edges } = reload({
      edges: [{ id: "e1", source: "a", target: "b", sourceHandle: "false" }],
    });

    expect(edges[0]?.sourceHandle).toBe("false");
  });

  // How an edge draws is the canvas's decision, made once in
  // `workflow-canvas.tsx` through `defaultEdgeOptions`. A stored graph that
  // carried its own answer is what used to survive a save and paint a reload
  // with React Flow's built-in bezier.
  it("stores no edge type, so no saved graph can decide how one draws", () => {
    const { edges } = reload({
      edges: [{ id: "e1", source: "a", target: "b", type: WORKFLOW_EDGE_TYPE }],
    });

    expect(
      toPersistedEdge({ id: "e1", source: "a", target: "b" })
    ).not.toHaveProperty("type");
    expect(edges[0]?.type).toBeUndefined();
  });

  it("stores nothing about the session looking at the graph", () => {
    const selectedEdge: WorkflowEdge = {
      id: "e1",
      source: "a",
      target: "b",
      selected: true,
    };

    expect(toPersistedEdge(selectedEdge)).not.toHaveProperty("selected");
    expect(toPersistedNode(editorNode("a", true))).not.toHaveProperty(
      "selected"
    );
    expect(toPersistedNode(editorNode("a", true))).not.toHaveProperty(
      "dragging"
    );

    const { nodes, edges } = reload({
      nodes: [editorNode("a", true), editorNode("b", false)],
      edges: [selectedEdge],
    });

    expect(nodes.every((item) => item.selected === undefined)).toBe(true);
    expect(edges[0]?.selected).toBeUndefined();
  });
});
