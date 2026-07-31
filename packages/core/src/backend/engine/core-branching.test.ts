import { beforeEach, describe, expect, it } from "vitest";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { stubRovaRuntime } from "#src/backend/lib/effect/test-layers";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { checkCelBooleanExpression } from "#src/backend/lib/cel/environment";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { defineAction } from "#src/backend/extensions/define-action";
import { Schema } from "effect";
import {
  compileConditionModel,
  type ConditionModel,
  serializeConditionModel,
} from "@rova/shared/conditions/conditions";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import type { WorkflowNode } from "@rova/shared/graph/types";
import { executionData } from "#src/backend/engine/contracts";
import { executeWorkflow } from "#src/backend/engine/core";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";

const WRAPPED_ACTION_ID = "test/wrapped-output-action";

const wrappedOutputAction = defineAction({
  id: WRAPPED_ACTION_ID,
  label: "Wrapped Output",
  description: "Returns its fields inside the standard step wrapper",
  input: Schema.Struct({}),
  handler: () => ({ donorId: "abc" }),
});

// The engine reaches an action's step and its label through the dispatch port
// the app builds, so the host action these cases run reaches the engine the way
// a host's would. The built-in two, Condition and Wait, ride in on the same
// assembly.
const actions = createWorkflowActions(
  assembleExtensions({ actions: [wrappedOutputAction] }),
  stubRovaRuntime()
);

function createLifecycleNode(id: string): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: {},
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
        createLifecycleNode("lifecycle_1"),
        createConditionNode("action_success", true),
        createUnknownActionNode("action_failure"),
        createConditionNode("join_node", true),
      ],
      edges: [
        {
          id: "edge_t_s",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "action_success",
        },
        {
          id: "edge_t_f",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "action_failure",
        },
        { id: "edge_s_j", source: "action_success", target: "join_node" },
        { id: "edge_f_j", source: "action_failure", target: "join_node" },
      ],
    });

    const result = await executeWorkflow(
      { graph, executionId: "exec_join", workflowId: "workflow_join" },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(false);
    expect(result.results.action_success?.success).toBe(true);
    expect(result.results.action_failure?.success).toBe(false);
    expect(result.results.join_node).toBeUndefined();
  });

  it("executes only the true branch when condition evaluates true", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createConditionNode("condition_node", true),
        createConditionNode("true_node", true),
        createConditionNode("false_node", true),
      ],
      edges: [
        {
          id: "edge_t_c",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "condition_node",
        },
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
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.condition_node?.success).toBe(true);
    // The Condition step answers in the same wrapper every other step uses, and
    // the decision it recorded is the branch that ran.
    expect(executionData(result.results.condition_node)).toEqual({
      success: true,
      data: { condition: true },
    });
    expect(result.results.true_node?.success).toBe(true);
    expect(result.results.false_node).toBeUndefined();
  });

  it("executes only the false branch when condition evaluates false", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createConditionNode("condition_node", false),
        createConditionNode("true_node", true),
        createConditionNode("false_node", true),
      ],
      edges: [
        {
          id: "edge_t_c",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "condition_node",
        },
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
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.condition_node?.success).toBe(true);
    expect(executionData(result.results.condition_node)).toEqual({
      success: true,
      data: { condition: false },
    });
    expect(result.results.true_node).toBeUndefined();
    expect(result.results.false_node?.success).toBe(true);
  });

  it("fans out to multiple targets on the selected condition branch", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createConditionNode("condition_node", true),
        createConditionNode("true_node_a", true),
        createConditionNode("true_node_b", true),
        createConditionNode("false_node", true),
      ],
      edges: [
        {
          id: "edge_t_c",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "condition_node",
        },
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
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.true_node_a?.success).toBe(true);
    expect(result.results.true_node_b?.success).toBe(true);
    expect(result.results.false_node).toBeUndefined();
  });
});

/**
 * A CEL condition reads bare field names out of one flat context merged from every
 * upstream node's output. Every step returns its fields inside a
 * `{ success, data }` wrapper, so these tests pin that the wrapper is transparent
 * here in the same way it is transparent to a template token.
 */
describe("condition context from upstream outputs", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  function createConditionRoutingGraph(expression: string) {
    return createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
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
        {
          id: "edge_t_a",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "action_1",
        },
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
        graph: createConditionRoutingGraph('payload.donorId == "abc"'),
        executionId: "exec_wrapped_condition",
        workflowId: "workflow_wrapped_condition",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.results.condition_node?.success).toBe(true);
    expect(result.results.true_node?.success).toBe(true);
    expect(result.results.false_node).toBeUndefined();
  });

  it("routes to the false branch when the wrapped field does not match", async () => {
    const result = await executeWorkflow(
      {
        graph: createConditionRoutingGraph('payload.donorId == "someone-else"'),
        executionId: "exec_wrapped_condition_false",
        workflowId: "workflow_wrapped_condition",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.results.true_node).toBeUndefined();
    expect(result.results.false_node?.success).toBe(true);
  });

  it("still reads a field from an output that carries no wrapper", async () => {
    // The Lifecycle Node's output is a plain record, so its fields sit directly in the context.
    const result = await executeWorkflow(
      {
        graph: createConditionRoutingGraph('payload.plan == "premium"'),
        executionId: "exec_plain_condition",
        workflowId: "workflow_plain_condition",
        startPayload: { plan: "premium" },
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
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
        createLifecycleNode("lifecycle_1"),
        createTimestampConditionNode({
          id: "condition_node",
          field: input.field,
          includeModel: input.includeModel,
        }),
        createConditionNode("true_node", true),
        createConditionNode("false_node", true),
      ],
      edges: [
        {
          id: "edge_t_c",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "condition_node",
        },
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
        startPayload: { appointment: { startsAt: isoDaysFromNow(1) } },
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
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
        startPayload: { appointment: { startsAt: isoDaysFromNow(30) } },
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
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
        startPayload: { appointment: { startsAt: isoDaysFromNow(1) } },
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
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
        startPayload: { plan: "premium" },
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.results.true_node).toBeUndefined();
    expect(result.results.false_node?.success).toBe(true);
  });
});

describe("conditions on fields named after CEL type constants", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  // Webhook payloads routinely carry a top-level `type`, which is also a CEL
  // type name. Both the check that guards saving and the evaluation at run time
  // have to accept it, so this builds the expression the way the editor does.
  function createGraph(value: string) {
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
              field: "type",
              fieldType: "string",
              operator: "equals",
              value,
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    if (!compiled.valid) {
      throw new Error(compiled.error);
    }

    expect(checkCelBooleanExpression(compiled.expression).ok).toBe(true);

    return createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        {
          id: "condition_node",
          type: "action",
          position: { x: 100, y: 100 },
          data: {
            label: "condition_node",
            type: "action",
            config: {
              actionType: "Condition",
              condition: compiled.expression,
              conditionModel: serializeConditionModel(model),
            },
          },
        },
        createConditionNode("true_node", true),
        createConditionNode("false_node", true),
      ],
      edges: [
        {
          id: "edge_t_c",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "condition_node",
        },
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

  it("routes on a payload field named type", async () => {
    const result = await executeWorkflow(
      {
        graph: createGraph("appointment.created"),
        executionId: "exec_type_condition",
        workflowId: "workflow_type_condition",
        startPayload: { type: "appointment.created" },
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.results.condition_node?.success).toBe(true);
    expect(result.results.true_node?.success).toBe(true);
    expect(result.results.false_node).toBeUndefined();
  });

  it("takes the false branch when that field does not match", async () => {
    const result = await executeWorkflow(
      {
        graph: createGraph("appointment.created"),
        executionId: "exec_type_condition_false",
        workflowId: "workflow_type_condition",
        startPayload: { type: "appointment.cancelled" },
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.results.true_node).toBeUndefined();
    expect(result.results.false_node?.success).toBe(true);
  });
});
