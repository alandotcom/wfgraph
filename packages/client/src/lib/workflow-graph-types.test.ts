import { describe, expect, it } from "vitest";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import type { WorkflowNode as PersistedWorkflowNode } from "@wfgraph/shared/graph/types";
import {
  COMPARISON_EDGE_ANNOTATION,
  COMPARISON_NODE_ANNOTATION,
  comparisonNodeTitle,
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

  it("strips symbol annotations while preserving adopter-owned comparison data", () => {
    const comparedNode: WorkflowNode = {
      ...editorNode("a", false),
      data: {
        ...editorNode("a", false).data,
        comparison: { owner: "adopter" },
        [COMPARISON_NODE_ANNOTATION]: { kind: "removed" },
      },
    };
    const comparedEdge: WorkflowEdge = {
      id: "comparison:removed:e1",
      source: "a",
      target: "b",
      data: {
        comparison: { owner: "adopter" },
        [COMPARISON_EDGE_ANNOTATION]: { kind: "removed", sourceId: "e1" },
      },
    };

    const persistedNode = toPersistedNode(comparedNode);
    const persistedData = persistedNode.data as Record<PropertyKey, unknown>;
    expect(persistedData.comparison).toEqual({ owner: "adopter" });
    expect(persistedData[COMPARISON_NODE_ANNOTATION]).toBeUndefined();
    expect(toPersistedEdge(comparedEdge)).toEqual({
      id: "e1",
      source: "a",
      target: "b",
      sourceHandle: undefined,
      targetHandle: undefined,
      data: { comparison: { owner: "adopter" } },
    });
  });

  it("does not treat string-key comparison data as a synthetic edge id", () => {
    const edge: WorkflowEdge = {
      id: "comparison:removed:adopter-edge",
      source: "a",
      target: "b",
      data: { comparison: { sourceId: "different-id" } },
    };

    expect(toPersistedEdge(edge)).toMatchObject({
      id: "comparison:removed:adopter-edge",
      data: { comparison: { sourceId: "different-id" } },
    });
  });

  it("adds comparison wording to a node's accessible name", () => {
    expect(
      workflowNodeAriaLabel({
        label: "Archive lead",
        type: "action",
        [COMPARISON_NODE_ANNOTATION]: { kind: "removed" },
      })
    ).toBe("Archive lead, Removed in comparison");
  });

  it("uses the catalog label or a safe fallback for comparison action names", () => {
    const data = {
      label: "   ",
      type: "action" as const,
      config: { actionType: "linear/find-issues" },
      [COMPARISON_NODE_ANNOTATION]: { kind: "added" as const },
    };
    const catalog = {
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
    };

    expect(comparisonNodeTitle(data, catalog)).toBe("Find issues");
    expect(workflowNodeAriaLabel(data, catalog)).toBe(
      "Find issues, Added in comparison"
    );
    expect(comparisonNodeTitle(data)).toBe("Unavailable action");
    expect(workflowNodeAriaLabel(data)).toBe(
      "Unavailable action, Added in comparison"
    );
  });

  it("uses node-type fallbacks for nodes that are not configured actions", () => {
    expect(
      comparisonNodeTitle({ label: "", type: "lifecycle", config: {} })
    ).toBe("Lifecycle");
    expect(comparisonNodeTitle({ label: "", type: "group", config: {} })).toBe(
      "Group"
    );
    expect(comparisonNodeTitle({ label: "", type: "action", config: {} })).toBe(
      "Action"
    );
  });
});
