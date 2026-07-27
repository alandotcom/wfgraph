import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  registerRuntimeAction,
  unregisterRuntimeAction,
} from "@/shared/workflow/action-registry";
import {
  compileConditionModel,
  type ConditionModel,
  serializeConditionModel,
} from "@/shared/workflow/conditions";
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

// `condition` is stored either as a literal boolean or as the CEL expression the
// condition editor compiles, which the engine evaluates against upstream outputs.
function createConditionNode(
  id: string,
  condition: boolean | string
): WorkflowNode {
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

// A condition that reads a timestamp field off the payload. Building the CEL
// from the model is what saving a workflow enforces, so these two stay in step
// the way a real node's do.
function createTimestampConditionNode(input: {
  id: string;
  field: string;
  includeModel: boolean;
}): WorkflowNode {
  const model: ConditionModel = {
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group_1",
        logic: "and",
        conditions: [
          {
            id: "rule_1",
            field: input.field,
            fieldType: "timestamp",
            operator: "within_next",
            amount: 3,
            unit: "days",
          },
        ],
      },
    ],
  };

  const compiled = compileConditionModel(model);
  if (!compiled.valid) {
    throw new Error(compiled.error);
  }

  return {
    id: input.id,
    type: "action",
    position: { x: 100, y: 100 },
    data: {
      label: input.id,
      type: "action",
      config: {
        actionType: "Condition",
        condition: compiled.expression,
        ...(input.includeModel
          ? { conditionModel: serializeConditionModel(model) }
          : {}),
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
    // The Condition step answers in the same wrapper every other step uses, and
    // the decision it recorded is the branch that ran.
    expect(result.results.condition_node?.data).toEqual({
      success: true,
      data: { condition: true },
    });
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
    expect(result.results.condition_node?.data).toEqual({
      success: true,
      data: { condition: false },
    });
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

/**
 * A CEL condition reads bare field names out of one flat context merged from every
 * upstream node's output. Runtime and plugin steps return their fields inside a
 * `{ success, data }` wrapper, so these tests pin that the wrapper is transparent
 * here in the same way it is transparent to a template token.
 */
describe("condition context from upstream outputs", () => {
  const WRAPPED_ACTION_ID = "test/wrapped-output-action";
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
    registerRuntimeAction({
      id: WRAPPED_ACTION_ID,
      label: "Wrapped Output",
      description: "Returns its fields inside the standard step wrapper",
      execute: () => ({ success: true, data: { donorId: "abc" } }),
    });
  });

  afterEach(() => {
    unregisterRuntimeAction(WRAPPED_ACTION_ID);
  });

  function createConditionRoutingGraph(expression: string) {
    return createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        {
          id: "action_1",
          type: "action",
          position: { x: 100, y: 100 },
          data: {
            label: "Wrapped Output",
            type: "action",
            config: { actionType: WRAPPED_ACTION_ID },
          },
        },
        createConditionNode("condition_node", expression),
        createConditionNode("true_node", true),
        createConditionNode("false_node", true),
      ],
      edges: [
        { id: "edge_t_a", source: "trigger_1", target: "action_1" },
        { id: "edge_a_c", source: "action_1", target: "condition_node" },
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
  }

  it("reads a field out of a step's success/data wrapper", async () => {
    const result = await executeWorkflow(
      {
        graph: createConditionRoutingGraph('donorId == "abc"'),
        executionId: "exec_wrapped_condition",
        workflowId: "workflow_wrapped_condition",
      },
      undefined,
      store
    );

    expect(result.results.condition_node?.success).toBe(true);
    expect(result.results.true_node?.success).toBe(true);
    expect(result.results.false_node).toBeUndefined();
  });

  it("routes to the false branch when the wrapped field does not match", async () => {
    const result = await executeWorkflow(
      {
        graph: createConditionRoutingGraph('donorId == "someone-else"'),
        executionId: "exec_wrapped_condition_false",
        workflowId: "workflow_wrapped_condition",
      },
      undefined,
      store
    );

    expect(result.results.true_node).toBeUndefined();
    expect(result.results.false_node?.success).toBe(true);
  });

  it("still reads a field from an output that carries no wrapper", async () => {
    // Trigger output is a plain record, so its fields sit directly in the context.
    const result = await executeWorkflow(
      {
        graph: createConditionRoutingGraph('plan == "premium"'),
        executionId: "exec_plain_condition",
        workflowId: "workflow_plain_condition",
        triggerInput: { plan: "premium" },
      },
      undefined,
      store
    );

    expect(result.results.true_node?.success).toBe(true);
    expect(result.results.false_node).toBeUndefined();
  });
});

describe("timestamp conditions against payload values", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  function createGraph(input: { field: string; includeModel: boolean }) {
    return createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        createTimestampConditionNode({
          id: "condition_node",
          field: input.field,
          includeModel: input.includeModel,
        }),
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
  }

  function isoDaysFromNow(days: number): string {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  it("routes on a timestamp the payload delivered as an ISO string", async () => {
    // JSON has no date type, so the payload carries text. CEL has no overload
    // comparing text to a Timestamp, so the value has to become a Date before
    // the expression runs or the comparison never gets the chance to be true.
    const result = await executeWorkflow(
      {
        graph: createGraph({
          field: "appointment.startsAt",
          includeModel: true,
        }),
        executionId: "exec_timestamp_condition",
        workflowId: "workflow_timestamp_condition",
        triggerInput: { appointment: { startsAt: isoDaysFromNow(1) } },
      },
      undefined,
      store
    );

    expect(result.results.condition_node?.success).toBe(true);
    expect(result.results.true_node?.success).toBe(true);
    expect(result.results.false_node).toBeUndefined();
  });

  it("takes the false branch when the timestamp falls outside the window", async () => {
    const result = await executeWorkflow(
      {
        graph: createGraph({
          field: "appointment.startsAt",
          includeModel: true,
        }),
        executionId: "exec_timestamp_condition_outside",
        workflowId: "workflow_timestamp_condition",
        triggerInput: { appointment: { startsAt: isoDaysFromNow(30) } },
      },
      undefined,
      store
    );

    expect(result.results.true_node).toBeUndefined();
    expect(result.results.false_node?.success).toBe(true);
  });

  it("leaves the value alone when the model does not call the field a timestamp", async () => {
    // Pins where the conversion comes from: the node's stored model, not a
    // guess at any string that happens to look like a date. Without the model
    // the string stays a string and the expression cannot evaluate.
    const result = await executeWorkflow(
      {
        graph: createGraph({
          field: "appointment.startsAt",
          includeModel: false,
        }),
        executionId: "exec_timestamp_condition_unmodelled",
        workflowId: "workflow_timestamp_condition",
        triggerInput: { appointment: { startsAt: isoDaysFromNow(1) } },
      },
      undefined,
      store
    );

    expect(result.results.true_node).toBeUndefined();
    expect(result.results.false_node?.success).toBe(true);
  });

  it("leaves a timestamp path the payload never carried absent", async () => {
    const result = await executeWorkflow(
      {
        graph: createGraph({
          field: "appointment.startsAt",
          includeModel: true,
        }),
        executionId: "exec_timestamp_condition_missing",
        workflowId: "workflow_timestamp_condition",
        triggerInput: { plan: "premium" },
      },
      undefined,
      store
    );

    expect(result.results.true_node).toBeUndefined();
    expect(result.results.false_node?.success).toBe(true);
  });
});
