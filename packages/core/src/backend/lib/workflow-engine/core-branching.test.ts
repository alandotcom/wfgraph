import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createSerializedWorkflowGraph } from "@/shared/workflow/graph";
import type { WorkflowNode } from "@/shared/workflow/types";
import { executeWorkflow } from "./core";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "./recording-store";

// Condition steps log through step-handler, which is not behind the store
// port; this stub keeps that path off a database.
mock.module("@/backend/lib/workflow-logging", () => ({
  logStepStartDb: () =>
    Promise.resolve({ logId: "mock-log-id", startTime: Date.now() }),
  logStepCompleteDb: () => Promise.resolve(),
  logWorkflowCompleteDb: () => Promise.resolve(),
}));

function createTriggerNode(id: string): WorkflowNode {
  return {
    id,
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Trigger",
      type: "trigger",
      config: {
        triggerType: "Trigger",
      },
    },
  };
}

function createConditionNode(id: string, condition: boolean): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 100, y: 100 },
    data: {
      label: id,
      type: "action",
      config: {
        actionType: "Condition",
        condition,
      },
    },
  };
}

function createUnknownActionNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 100, y: 100 },
    data: {
      label: id,
      type: "action",
      config: {
        actionType: "Unknown Action",
      },
    },
  };
}

function createConditionBranchEdge(input: {
  id: string;
  source: string;
  target: string;
  branch: "true" | "false";
}) {
  return {
    id: input.id,
    source: input.source,
    target: input.target,
    sourceHandle: input.branch,
  };
}

describe("executeWorkflow branch traversal", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  it("does not execute a join node until all inbound dependencies are downstream-ready", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        createConditionNode("action_success", true),
        createUnknownActionNode("action_failure"),
        createConditionNode("join_node", true),
      ],
      edges: [
        { id: "edge_t_s", source: "trigger_1", target: "action_success" },
        { id: "edge_t_f", source: "trigger_1", target: "action_failure" },
        { id: "edge_s_j", source: "action_success", target: "join_node" },
        { id: "edge_f_j", source: "action_failure", target: "join_node" },
      ],
    });

    const result = await executeWorkflow(
      { graph, executionId: "exec_join", workflowId: "workflow_join" },
      undefined,
      store
    );

    expect(result.success).toBe(false);
    expect(result.results.action_success?.success).toBe(true);
    expect(result.results.action_failure?.success).toBe(false);
    expect(result.results.join_node).toBeUndefined();
  });

  it("executes only the true branch when condition evaluates true", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        createConditionNode("condition_node", true),
        createConditionNode("true_node", true),
        createConditionNode("false_node", true),
      ],
      edges: [
        { id: "edge_t_c", source: "trigger_1", target: "condition_node" },
        createConditionBranchEdge({
          id: "edge_c_true",
          source: "condition_node",
          target: "true_node",
          branch: "true",
        }),
        createConditionBranchEdge({
          id: "edge_c_false",
          source: "condition_node",
          target: "false_node",
          branch: "false",
        }),
      ],
    });

    const result = await executeWorkflow(
      {
        graph,
        executionId: "exec_condition",
        workflowId: "workflow_condition",
      },
      undefined,
      store
    );

    expect(result.success).toBe(true);
    expect(result.results.condition_node?.success).toBe(true);
    expect(result.results.true_node?.success).toBe(true);
    expect(result.results.false_node).toBeUndefined();
  });

  it("executes only the false branch when condition evaluates false", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        createConditionNode("condition_node", false),
        createConditionNode("true_node", true),
        createConditionNode("false_node", true),
      ],
      edges: [
        { id: "edge_t_c", source: "trigger_1", target: "condition_node" },
        createConditionBranchEdge({
          id: "edge_c_true",
          source: "condition_node",
          target: "true_node",
          branch: "true",
        }),
        createConditionBranchEdge({
          id: "edge_c_false",
          source: "condition_node",
          target: "false_node",
          branch: "false",
        }),
      ],
    });

    const result = await executeWorkflow(
      {
        graph,
        executionId: "exec_condition",
        workflowId: "workflow_condition",
      },
      undefined,
      store
    );

    expect(result.success).toBe(true);
    expect(result.results.condition_node?.success).toBe(true);
    expect(result.results.true_node).toBeUndefined();
    expect(result.results.false_node?.success).toBe(true);
  });

  it("fans out to multiple targets on the selected condition branch", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        createConditionNode("condition_node", true),
        createConditionNode("true_node_a", true),
        createConditionNode("true_node_b", true),
        createConditionNode("false_node", true),
      ],
      edges: [
        { id: "edge_t_c", source: "trigger_1", target: "condition_node" },
        createConditionBranchEdge({
          id: "edge_c_true_a",
          source: "condition_node",
          target: "true_node_a",
          branch: "true",
        }),
        createConditionBranchEdge({
          id: "edge_c_true_b",
          source: "condition_node",
          target: "true_node_b",
          branch: "true",
        }),
        createConditionBranchEdge({
          id: "edge_c_false",
          source: "condition_node",
          target: "false_node",
          branch: "false",
        }),
      ],
    });

    const result = await executeWorkflow(
      {
        graph,
        executionId: "exec_condition",
        workflowId: "workflow_condition",
      },
      undefined,
      store
    );

    expect(result.success).toBe(true);
    expect(result.results.true_node_a?.success).toBe(true);
    expect(result.results.true_node_b?.success).toBe(true);
    expect(result.results.false_node).toBeUndefined();
  });
});
