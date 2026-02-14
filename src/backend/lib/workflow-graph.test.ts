import { describe, expect, it } from "bun:test";
import { validateWorkflowGraph } from "@/backend/lib/workflow-graph";
import { createSerializedWorkflowGraph } from "@/shared/workflow/graph";
import type {
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from "@/shared/workflow/types";

function createBaseTriggerNode(id = "trigger_1"): WorkflowNode {
  return {
    id,
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Trigger",
      type: "trigger",
      config: { triggerType: "Webhook" },
    },
  };
}

function createActionNode(id = "action_1"): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 100, y: 100 },
    data: {
      label: "Action",
      type: "action",
      config: { actionType: "HTTP Request" },
    },
  };
}

function createEdge(
  source: string,
  target: string,
  id = "edge_1"
): WorkflowEdge {
  return {
    id,
    source,
    target,
  };
}

describe("validateWorkflowGraph", () => {
  it("accepts a valid DAG graph", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [createBaseTriggerNode(), createActionNode()],
      edges: [createEdge("trigger_1", "action_1")],
    });

    const result = validateWorkflowGraph(graph);

    expect(result.valid).toBe(true);
  });

  it("rejects malformed node attributes", () => {
    const graph = {
      nodes: [
        {
          key: "trigger_1",
          attributes: {
            id: "trigger_1",
            type: "trigger",
            position: { x: 0, y: 0 },
            data: {
              label: "Trigger",
              // missing data.type on purpose
              config: { triggerType: "Webhook" },
            },
          },
        },
      ],
      edges: [],
    } as unknown;

    const result = validateWorkflowGraph(graph);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("data.type");
    }
  });

  it("rejects mismatched node keys and attribute IDs", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [createBaseTriggerNode()],
      edges: [],
    });

    const tampered: SerializedWorkflowGraph = {
      ...graph,
      nodes: [
        {
          ...graph.nodes[0],
          key: "other_node_key",
        },
      ],
    };

    const result = validateWorkflowGraph(tampered);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("must match");
    }
  });

  it("rejects cyclic graphs", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [createBaseTriggerNode(), createActionNode("action_2")],
      edges: [
        createEdge("trigger_1", "action_2", "edge_1"),
        createEdge("action_2", "trigger_1", "edge_2"),
      ],
    });

    const result = validateWorkflowGraph(graph);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("acyclic");
    }
  });
});
