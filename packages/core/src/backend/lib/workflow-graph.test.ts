import { describe, expect, it } from "vitest";
import { validateWorkflowGraph } from "#src/backend/lib/workflow-graph";
import { createSerializedWorkflowGraph } from "@rova/shared/workflow/graph";
import type {
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from "@rova/shared/workflow/types";

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

function createConditionActionNode(id = "condition_1"): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 100, y: 100 },
    data: {
      label: "Condition",
      type: "action",
      config: { actionType: "Condition", condition: true },
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

function createConditionEdge(
  source: string,
  target: string,
  branch: "true" | "false",
  id: string
): WorkflowEdge {
  return {
    id,
    source,
    target,
    sourceHandle: branch,
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
      // No `type` means no arm of the node data union is selected, so the
      // failure lands on `data` and names what a node data type has to be.
      // The node's own fields stay out of the message: the editor put them
      // there, and this string is persisted as a run error.
      expect(result.error).toBe(
        'nodes[0].attributes.data: Node data needs a type of "trigger", "action", or "add"'
      );
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

  it("accepts condition edges with explicit true/false handles", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createBaseTriggerNode("trigger_1"),
        createConditionActionNode("condition_1"),
        createActionNode("action_true"),
        createActionNode("action_false"),
      ],
      edges: [
        createEdge("trigger_1", "condition_1", "edge_trigger_condition"),
        createConditionEdge(
          "condition_1",
          "action_true",
          "true",
          "edge_condition_true"
        ),
        createConditionEdge(
          "condition_1",
          "action_false",
          "false",
          "edge_condition_false"
        ),
      ],
    });

    const result = validateWorkflowGraph(graph);

    expect(result.valid).toBe(true);
  });

  it("rejects condition edges without explicit branch handles", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createBaseTriggerNode("trigger_1"),
        createConditionActionNode("condition_1"),
        createActionNode("action_true"),
      ],
      edges: [
        createEdge("trigger_1", "condition_1", "edge_trigger_condition"),
        createEdge("condition_1", "action_true", "edge_condition_unlabeled"),
      ],
    });

    const result = validateWorkflowGraph(graph);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('sourceHandle "true" or "false"');
    }
  });

  it("rejects true/false handles emitted by non-condition nodes", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createBaseTriggerNode("trigger_1"),
        createActionNode("action_1"),
        createActionNode("action_2"),
      ],
      edges: [
        createEdge("trigger_1", "action_1", "edge_trigger_action"),
        createConditionEdge("action_1", "action_2", "true", "edge_invalid"),
      ],
    });

    const result = validateWorkflowGraph(graph);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Only Condition nodes");
    }
  });

  it("rejects graphs where a node has more than one incoming edge", () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createBaseTriggerNode("trigger_1"),
        createActionNode("action_1"),
        createActionNode("action_2"),
        createActionNode("action_target"),
      ],
      edges: [
        createEdge("trigger_1", "action_1", "edge_trigger_action_1"),
        createEdge("trigger_1", "action_2", "edge_trigger_action_2"),
        createEdge("action_1", "action_target", "edge_action_1_target"),
        createEdge("action_2", "action_target", "edge_action_2_target"),
      ],
    });

    const result = validateWorkflowGraph(graph);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("multiple incoming edges");
    }
  });
});
