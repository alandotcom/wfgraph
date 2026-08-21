import { beforeEach, describe, expect, it } from "vitest";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { checkCelBooleanExpression } from "#src/backend/lib/cel/environment";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { defineAction } from "#src/backend/extensions/define-action";
import { Schema } from "effect";
import {
  compileConditionModel,
  type ConditionModel,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { executionData } from "#src/backend/engine/contracts";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
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
  stubWfGraphRuntime()
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

// An ordinary action node, which routes nothing: its one outgoing edge is what
// the run does next.
function createWrappedActionNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 100, y: 100 },
    data: {
      label: "Wrapped Output",
      type: "action",
      config: { actionType: WRAPPED_ACTION_ID },
    },
  };
}

// The toggle the config panel writes. The engine skips the node's work and
// emits a null output in its place.
function disableNode(node: WorkflowNode): WorkflowNode {
  return { ...node, data: { ...node.data, enabled: false } };
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

  it("stops the branch at a disabled Condition rather than taking both", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        disableNode(createConditionNode("condition_node", true)),
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
        executionId: "exec_condition_disabled",
        workflowId: "workflow_condition",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.condition_node?.success).toBe(true);
    // Both edges below the node name a branch its decision would have picked
    // between. Taking either without a decision is a guess, and taking both
    // sends the true message and the false one to the same person.
    expect(result.results.true_node).toBeUndefined();
    expect(result.results.false_node).toBeUndefined();
  });

  // The same rule for a node that decides no routing. A step below a skipped
  // lookup would read the null it left behind as an answer, so the branch ends
  // at the disabled node whatever kind of node it is.
  it("stops the branch at a disabled action node", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        disableNode(createWrappedActionNode("disabled_action")),
        createConditionNode("below_node", true),
      ],
      edges: [
        {
          id: "edge_l_a",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "disabled_action",
        },
        { id: "edge_a_b", source: "disabled_action", target: "below_node" },
      ],
    });

    const result = await executeWorkflow(
      {
        graph,
        executionId: "exec_disabled_action",
        workflowId: "workflow_disabled_action",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.below_node).toBeUndefined();
    // The skipped node is still recorded, so the run's trace shows where the
    // branch ended and a reader is not left with a silent hole.
    expect(result.results.disabled_action?.success).toBe(true);
    expect(executionData(result.results.disabled_action)).toBeNull();
  });

  // A disabled Wait parks nothing and is not held back with the other waits, so
  // the rule has to reach it on the path it takes through the scheduler.
  it("stops the branch at a disabled Wait", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        disableNode({
          id: "wait_1",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Wait",
            type: "action",
            config: {
              actionType: "Wait",
              waitMode: "delay",
              waitDuration: "1h",
            },
          },
        }),
        createConditionNode("below_node", true),
      ],
      edges: [
        {
          id: "edge_l_w",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "wait_1",
        },
        { id: "edge_w_b", source: "wait_1", target: "below_node" },
      ],
    });

    const result = await executeWorkflow(
      {
        graph,
        executionId: "exec_disabled_wait",
        workflowId: "workflow_disabled_wait",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.wait_1?.success).toBe(true);
    expect(result.results.below_node).toBeUndefined();
  });

  // What the editor's muting rests on: a node is ready only once every
  // predecessor released it, so an arm that never arrives holds the join for
  // the life of the run.
  it("holds a join whose other arm was disabled", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createWrappedActionNode("live_arm"),
        disableNode(createWrappedActionNode("dead_arm")),
        createConditionNode("join_node", true),
      ],
      edges: [
        {
          id: "edge_l_live",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "live_arm",
        },
        {
          id: "edge_l_dead",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "dead_arm",
        },
        { id: "edge_live_join", source: "live_arm", target: "join_node" },
        { id: "edge_dead_join", source: "dead_arm", target: "join_node" },
      ],
    });

    const result = await executeWorkflow(
      {
        graph,
        executionId: "exec_disabled_arm",
        workflowId: "workflow_disabled_arm",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.results.live_arm?.success).toBe(true);
    expect(result.results.join_node).toBeUndefined();
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

describe("executeWorkflow Event Split traversal", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  function createSplitNode(): WorkflowNode {
    return {
      id: "split_1",
      type: "action",
      position: { x: 100, y: 100 },
      data: {
        label: "Split on Event",
        type: "action",
        config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
      },
    };
  }

  function createSplitGraph(split: WorkflowNode = createSplitNode()) {
    return createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        split,
        createConditionNode("on_created", true),
        createConditionNode("on_rescheduled", true),
      ],
      edges: [
        {
          id: "edge_l_s",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "split_1",
        },
        {
          id: "edge_s_created",
          source: "split_1",
          sourceHandle: eventSplitOutlet("app/appointment.created"),
          target: "on_created",
        },
        {
          id: "edge_s_rescheduled",
          source: "split_1",
          sourceHandle: eventSplitOutlet("app/appointment.rescheduled"),
          target: "on_rescheduled",
        },
      ],
    });
  }

  it("runs only the branch belonging to the Event the run arrived on", async () => {
    const result = await executeWorkflow(
      {
        graph: createSplitGraph(),
        executionId: "exec_split",
        workflowId: "workflow_split",
        startEventName: "app/appointment.rescheduled",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.on_rescheduled?.success).toBe(true);
    expect(result.results.on_created).toBeUndefined();
    // The step records which Event it routed on, so a run's trace says why the
    // other branch stayed unvisited.
    expect(executionData(result.results.split_1)).toEqual({
      success: true,
      data: { event: "app/appointment.rescheduled" },
    });
  });

  it("stops the branch at a disabled Event Split rather than firing every outlet", async () => {
    const result = await executeWorkflow(
      {
        graph: createSplitGraph(disableNode(createSplitNode())),
        executionId: "exec_split_disabled",
        workflowId: "workflow_split",
        startEventName: "app/appointment.rescheduled",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.split_1?.success).toBe(true);
    // One arrival would otherwise run the branch for every Event at once.
    expect(result.results.on_created).toBeUndefined();
    expect(result.results.on_rescheduled).toBeUndefined();
  });

  it("ends the run where no outlet claims the Event", async () => {
    // A manual start carries no Event, so every outlet names something else.
    const result = await executeWorkflow(
      {
        graph: createSplitGraph(),
        executionId: "exec_split_manual",
        workflowId: "workflow_split",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.split_1?.success).toBe(true);
    expect(result.results.on_created).toBeUndefined();
    expect(result.results.on_rescheduled).toBeUndefined();
  });
});

describe("executeWorkflow Event Split after Wait", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  const SETTLED = "billing/payment.settled";
  const FAILED = "billing/payment.failed";
  const CREATED = "app/appointment.created";

  function waitResumeSignal(
    eventType: string,
    payload: Record<string, string>
  ) {
    return {
      name: "workflow/wait.signal",
      id: "evt_signal",
      ts: 0,
      data: {
        executionId: "exec_wait_split",
        nodeId: "wait_1",
        token: "token_1",
        eventType,
        signalType: "wait-resume",
        payload,
      },
    };
  }

  function createWaitSplitGraph() {
    return createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        {
          id: "wait_1",
          type: "action",
          position: { x: 0, y: 100 },
          data: {
            label: "Wait",
            type: "action",
            config: {
              actionType: BUILT_IN_ACTION_IDS.wait,
              waitMode: "event",
              waitFor: [{ event: SETTLED }, { event: FAILED }],
              waitTimeout: "7d",
            },
          },
        },
        {
          id: "split_1",
          type: "action",
          position: { x: 0, y: 200 },
          data: {
            label: "Split on Event",
            type: "action",
            config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
          },
        },
        createConditionNode("on_settled", true),
        createConditionNode("on_failed", true),
        createConditionNode("on_created", true),
      ],
      edges: [
        {
          id: "edge_l_w",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "wait_1",
        },
        { id: "edge_w_s", source: "wait_1", target: "split_1" },
        {
          id: "edge_s_settled",
          source: "split_1",
          sourceHandle: eventSplitOutlet(SETTLED),
          target: "on_settled",
        },
        {
          id: "edge_s_failed",
          source: "split_1",
          sourceHandle: eventSplitOutlet(FAILED),
          target: "on_failed",
        },
        {
          id: "edge_s_created",
          source: "split_1",
          sourceHandle: eventSplitOutlet(CREATED),
          target: "on_created",
        },
      ],
    });
  }

  it("runs the branch belonging to the Event that woke the Wait", async () => {
    const result = await executeWorkflow(
      {
        graph: createWaitSplitGraph(),
        executionId: "exec_wait_split",
        workflowId: "workflow_wait_split",
        startEventName: CREATED,
        startPayload: { appointmentId: "appt_1" },
      },
      createInMemoryWorkflowRuntime({
        resumeEvent: waitResumeSignal(SETTLED, { amount: "40" }),
      }),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.on_settled?.success).toBe(true);
    expect(result.results.on_failed).toBeUndefined();
    // The Start Event put the run at the Wait; it is not what the split below
    // routes on, even when that outlet is wired.
    expect(result.results.on_created).toBeUndefined();
    expect(executionData(result.results.split_1)).toEqual({
      success: true,
      data: { event: SETTLED },
    });
    // The entry node's output is the payload that woke the Wait, matching the
    // Events the editor now offers below it.
    expect(result.outputs.lifecycle_1?.data).toEqual({ amount: "40" });
  });

  it("still splits on the Start Event after a delay Wait", async () => {
    const result = await executeWorkflow(
      {
        graph: createSerializedWorkflowGraph({
          nodes: [
            createLifecycleNode("lifecycle_1"),
            {
              id: "wait_1",
              type: "action",
              position: { x: 0, y: 100 },
              data: {
                label: "Wait",
                type: "action",
                config: {
                  actionType: BUILT_IN_ACTION_IDS.wait,
                  waitMode: "delay",
                  waitDuration: "1s",
                },
              },
            },
            {
              id: "split_1",
              type: "action",
              position: { x: 0, y: 200 },
              data: {
                label: "Split on Event",
                type: "action",
                config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
              },
            },
            createConditionNode("on_created", true),
            createConditionNode("on_settled", true),
          ],
          edges: [
            {
              id: "edge_l_w",
              source: "lifecycle_1",
              sourceHandle: "started",
              target: "wait_1",
            },
            { id: "edge_w_s", source: "wait_1", target: "split_1" },
            {
              id: "edge_s_created",
              source: "split_1",
              sourceHandle: eventSplitOutlet(CREATED),
              target: "on_created",
            },
            {
              id: "edge_s_settled",
              source: "split_1",
              sourceHandle: eventSplitOutlet(SETTLED),
              target: "on_settled",
            },
          ],
        }),
        executionId: "exec_delay_split",
        workflowId: "workflow_delay_split",
        startEventName: CREATED,
        startPayload: { appointmentId: "appt_1" },
      },
      createInMemoryWorkflowRuntime({ skipSleep: true }),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.on_created?.success).toBe(true);
    expect(result.results.on_settled).toBeUndefined();
    expect(result.outputs.lifecycle_1?.data).toEqual({
      appointmentId: "appt_1",
    });
  });
});
