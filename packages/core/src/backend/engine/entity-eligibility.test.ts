import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  compileConditionModel,
  entityStateConditionPath,
  serializeConditionModel,
  type ConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { LIFECYCLE_CANCELED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { WorkflowActions } from "#src/backend/engine/actions";
import type { WorkflowEntities } from "#src/backend/engine/entities";
import { executionData } from "#src/backend/engine/contracts";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { executeTestWorkflow } from "#src/backend/engine/test-execution";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  actionNode,
  condition,
  defineEntityEligibilityReplayCases,
  entityPort,
  executionInput,
  graph,
  lifecycleNode,
} from "#src/backend/engine/entity-eligibility.replay-cases";

const entityNameToken = "{{@$entity:appointment|Appointment.name}}";
const entityConditionModel: ConditionModel = {
  version: 2,
  groupLogic: "and",
  groups: [
    {
      id: "entity-group",
      logic: "and",
      conditions: [
        {
          id: "entity-rule",
          field: entityStateConditionPath("appointment", "status") ?? "",
          fieldType: "string",
          operator: "equals",
          value: "ready",
        },
      ],
    },
  ],
};
const compiledEntityCondition = compileConditionModel(entityConditionModel);
if (!compiledEntityCondition.valid) {
  throw new Error(compiledEntityCondition.error);
}

const structuredEntityConditionModel: ConditionModel = {
  version: 2,
  groupLogic: "and",
  groups: [
    {
      id: "structured-entity-group",
      logic: "and",
      conditions: [
        {
          id: "nested-string",
          field:
            entityStateConditionPath("appointment", "profile.status") ?? "",
          fieldType: "string",
          operator: "equals",
          value: "ready",
        },
        {
          id: "record-key",
          field: entityStateConditionPath("appointment", "attributes") ?? "",
          recordKey: "journey.status",
          fieldType: "string",
          operator: "equals",
          value: "priority",
        },
        {
          id: "nested-timestamp",
          field:
            entityStateConditionPath("appointment", "profile.updatedAt") ?? "",
          fieldType: "timestamp",
          operator: "before",
          dateTime: "2030-01-01T00:00:00.000Z",
        },
      ],
    },
  ],
};
const compiledStructuredEntityCondition = compileConditionModel(
  structuredEntityConditionModel
);
if (!compiledStructuredEntityCondition.valid) {
  throw new Error(compiledStructuredEntityCondition.error);
}

function entityDataGraph(
  checkpoints: Array<"before-execution" | "before-node">,
  nodeIds: string[] = ["first"],
  eligibilityCondition: string | null = condition
) {
  return createSerializedWorkflowGraph({
    nodes: [
      lifecycleNode(checkpoints, [], eligibilityCondition),
      ...nodeIds.map((id) =>
        actionNode(id, true, "test/action", {
          message: entityNameToken,
        })
      ),
    ],
    edges: nodeIds.map((id, index) => ({
      id: `edge-${id}`,
      source: index === 0 ? "lifecycle" : (nodeIds[index - 1] ?? "lifecycle"),
      sourceHandle: index === 0 ? "started" : undefined,
      target: id,
    })),
  });
}

const runAction = vi.fn((_input: Record<string, unknown>, _steps?: unknown) =>
  Effect.succeed({ success: true as const, data: {} })
);
const actions: WorkflowActions = {
  stepFor: () => runAction,
  metadataFor: () => ({
    label: "Test action",
    literalConfigKeys: [],
    templateJsonConfigShapes: [],
  }),
  catalogFingerprint: () => "catalog",
};

describe("per-node Entity Eligibility", () => {
  beforeEach(() => {
    runAction.mockClear();
  });

  it("resolves independently before each enabled Started-side action", async () => {
    const store = createRecordingWorkflowStore();
    const entities = entityPort([
      { outcome: "eligible" },
      { outcome: "eligible" },
    ]);

    const result = await executeTestWorkflow(
      executionInput,
      createInMemoryWorkflowRuntime(),
      store,
      actions,
      entities
    );

    expect(result.status).toBe("completed");
    expect(runAction).toHaveBeenCalledTimes(2);
    expect(entities.inputs).toEqual([
      {
        entityType: "appointment",
        entityId: "appt_secret",
        nodeId: "first",
        condition,
        eventName: "appointment.started",
        paths: [],
      },
      {
        entityType: "appointment",
        entityId: "appt_secret",
        nodeId: "second",
        condition,
        eventName: "appointment.started",
        paths: [],
      },
    ]);
    expect(store.callsOf("admitNode")).toHaveLength(4);
  });

  it("shares one current-state snapshot between Eligibility and templates", async () => {
    const entities = entityPort([{ outcome: "eligible" }], [{ name: "Ada" }]);

    const result = await executeTestWorkflow(
      { ...executionInput, graph: entityDataGraph(["before-node"]) },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(result.status).toBe("completed");
    expect(entities.inputs).toEqual([
      {
        entityType: "appointment",
        entityId: "appt_secret",
        nodeId: "first",
        condition,
        eventName: "appointment.started",
        paths: ["name"],
      },
    ]);
    expect(runAction).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Ada" }),
      expect.anything()
    );
    expect(JSON.stringify(result.outputs)).not.toContain("Ada");
  });

  it("resolves referenced Entity data when tracking has no Eligibility", async () => {
    const entities = entityPort([{ outcome: "eligible" }], [{ name: "Ada" }]);

    const result = await executeTestWorkflow(
      {
        ...executionInput,
        graph: entityDataGraph(["before-node"], ["first"], null),
      },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(result.status).toBe("completed");
    expect(entities.inputs).toEqual([
      {
        entityType: "appointment",
        entityId: "appt_secret",
        nodeId: "first",
        eventName: "appointment.started",
        paths: ["name"],
      },
    ]);
    expect(runAction).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Ada" }),
      expect.anything()
    );
  });

  it("evaluates a Condition node against tracked Entity State without Eligibility", async () => {
    const entities = entityPort(
      [{ outcome: "eligible" }],
      [{ status: "ready" }]
    );
    const conditionGraph = createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode(["before-node"], [], null),
        actionNode("condition", true, "Condition", {
          condition: compiledEntityCondition.expression,
          conditionModel: serializeConditionModel(entityConditionModel),
        }),
      ],
      edges: [
        {
          id: "entity-condition",
          source: "lifecycle",
          sourceHandle: "started",
          target: "condition",
        },
      ],
    });

    const result = await executeTestWorkflow(
      { ...executionInput, graph: conditionGraph },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(result.status).toBe("completed");
    expect(entities.inputs).toEqual([
      {
        entityType: "appointment",
        entityId: "appt_secret",
        nodeId: "condition",
        eventName: "appointment.started",
        paths: ["status"],
      },
    ]);
    expect(executionData(result.results.condition)).toEqual({
      success: true,
      data: { condition: true },
    });
  });

  it("evaluates nested, open-record, and timestamp Entity fields from the projected snapshot", async () => {
    const entities = entityPort(
      [{ outcome: "eligible" }],
      [
        {
          "profile.status": "ready",
          'attributes["journey.status"]': "priority",
          "profile.updatedAt": "2029-01-01T00:00:00.000Z",
        },
      ]
    );
    const conditionGraph = createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode(["before-node"], [], null),
        actionNode("condition", true, "Condition", {
          condition: compiledStructuredEntityCondition.expression,
          conditionModel: serializeConditionModel(
            structuredEntityConditionModel
          ),
        }),
      ],
      edges: [
        {
          id: "entity-condition",
          source: "lifecycle",
          sourceHandle: "started",
          target: "condition",
        },
      ],
    });

    const result = await executeTestWorkflow(
      { ...executionInput, graph: conditionGraph },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(result.status).toBe("completed");
    expect(entities.inputs).toEqual([
      expect.objectContaining({
        nodeId: "condition",
        paths: [
          "profile.status",
          'attributes["journey.status"]',
          "profile.updatedAt",
        ],
      }),
    ]);
    expect(executionData(result.results.condition)).toEqual({
      success: true,
      data: { condition: true },
    });
  });

  it("does not retarget a stale Entity Condition reference when the current type reads the same path", async () => {
    const mixedModel: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "mixed-entity-types",
          logic: "and",
          conditions: [
            {
              id: "current",
              field: entityStateConditionPath("appointment", "status") ?? "",
              fieldType: "string",
              operator: "equals",
              value: "ready",
            },
            {
              id: "stale",
              field: entityStateConditionPath("patient", "status") ?? "",
              fieldType: "string",
              operator: "equals",
              value: "ready",
            },
          ],
        },
      ],
    };
    const compiled = compileConditionModel(mixedModel);
    if (!compiled.valid) {
      throw new Error(compiled.error);
    }
    const entities = entityPort(
      [{ outcome: "eligible" }],
      [{ status: "ready" }]
    );
    const conditionGraph = createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode(["before-node"], [], null),
        actionNode("condition", true, "Condition", {
          condition: compiled.expression,
          conditionModel: serializeConditionModel(mixedModel),
        }),
      ],
      edges: [
        {
          id: "entity-condition",
          source: "lifecycle",
          sourceHandle: "started",
          target: "condition",
        },
      ],
    });

    const result = await executeTestWorkflow(
      { ...executionInput, graph: conditionGraph },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(entities.inputs).toEqual([
      expect.objectContaining({ paths: ["status"] }),
    ]);
    expect(executionData(result.results.condition)).toEqual({
      success: true,
      data: { condition: false },
    });
  });

  it("does not retarget a stale Entity reference during a Draft run", async () => {
    const staleToken = "{{@$entity:patient|Appointment.name}}";
    const staleGraph = createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode(["before-node"]),
        actionNode("first", true, "test/action", { message: staleToken }),
      ],
      edges: [
        {
          id: "edge-first",
          source: "lifecycle",
          sourceHandle: "started",
          target: "first",
        },
      ],
    });
    const entities = entityPort(
      [{ outcome: "eligible" }],
      [{ name: "Wrong Entity" }]
    );

    await executeTestWorkflow(
      { ...executionInput, graph: staleGraph },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(entities.inputs).toEqual([
      expect.objectContaining({ nodeId: "first", paths: [] }),
    ]);
    expect(runAction).toHaveBeenCalledWith(
      expect.objectContaining({ message: staleToken }),
      expect.anything()
    );
  });

  it("projects only Entity references from JSON values execution consumes", async () => {
    const recordToken = '{{@$entity:appointment|Appointment.tags["order.id"]}}';
    const jsonGraph = createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode(),
        actionNode("first", true, "test/action", {
          variables: JSON.stringify({
            [recordToken]: "literal key",
            SEGMENT: recordToken,
          }),
          nested: { value: recordToken },
        }),
      ],
      edges: [
        {
          id: "edge-first",
          source: "lifecycle",
          sourceHandle: "started",
          target: "first",
        },
      ],
    });
    const jsonActions: WorkflowActions = {
      ...actions,
      metadataFor: () => ({
        label: "Test action",
        literalConfigKeys: [],
        templateJsonConfigShapes: [["variables", "provider-fields"]],
      }),
    };
    const entities = entityPort(
      [{ outcome: "eligible" }],
      [{ 'tags["order.id"]': "priority" }]
    );

    await executeTestWorkflow(
      { ...executionInput, graph: jsonGraph },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      jsonActions,
      entities
    );

    expect(entities.inputs).toEqual([
      expect.objectContaining({
        nodeId: "first",
        paths: ['tags["order.id"]'],
      }),
    ]);
    expect(runAction).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: JSON.stringify({
          [recordToken]: "literal key",
          SEGMENT: "priority",
        }),
        nested: { value: recordToken },
      }),
      expect.anything()
    );
  });

  it("resolves fresh Entity State before each consuming node", async () => {
    const entities = entityPort(
      [{ outcome: "eligible" }, { outcome: "eligible" }],
      [{ name: "Ada" }, { name: "Grace" }]
    );

    const result = await executeTestWorkflow(
      {
        ...executionInput,
        graph: entityDataGraph(["before-execution"], ["first", "second"]),
      },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(result.status).toBe("completed");
    expect(entities.inputs).toHaveLength(2);
    expect(entities.inputs).toEqual([
      expect.objectContaining({ nodeId: "first", paths: ["name"] }),
      expect.objectContaining({ nodeId: "second", paths: ["name"] }),
    ]);
    expect(runAction.mock.calls.map(([config]) => config.message)).toEqual([
      "Ada",
      "Grace",
    ]);
  });

  it("does not resolve Entity references in inactive Wait fields", async () => {
    const inactiveToken = "{{@$entity:appointment|Appointment.gone}}";
    const waitGraph = createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode(["before-execution"]),
        actionNode("wait", true, "Wait", {
          waitMode: "delay",
          waitDuration: "1ms",
          waitTimeout: inactiveToken,
        }),
      ],
      edges: [
        {
          id: "edge-wait",
          source: "lifecycle",
          sourceHandle: "started",
          target: "wait",
        },
      ],
    });
    const entities = entityPort([]);

    const result = await executeTestWorkflow(
      { ...executionInput, graph: waitGraph },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(result.status).toBe("completed");
    expect(entities.inputs).toEqual([]);
  });

  it("claims exit before an ineligible node and admits no later work", async () => {
    const store = createRecordingWorkflowStore();
    const entities = entityPort([
      { outcome: "eligible" },
      {
        outcome: "exit",
        reason: "entity_condition_not_met",
        checkedAt: "2026-10-19T15:00:00.000Z",
      },
    ]);

    const result = await executeTestWorkflow(
      executionInput,
      createInMemoryWorkflowRuntime(),
      store,
      actions,
      entities
    );

    expect(result).toMatchObject({
      status: "exited",
      success: true,
      exit: {
        reason: "entity_condition_not_met",
        entityType: "appointment",
        nodeId: "second",
        checkedAt: "2026-10-19T15:00:00.000Z",
      },
    });
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(store.callsOf("requestExit")).toEqual([
      {
        executionId: "exec_entity",
        reason: "entity_condition_not_met",
        nodeId: "second",
        checkedAt: "2026-10-19T15:00:00.000Z",
      },
    ]);
    expect(store.callsOf("completeRun")[0]?.ending.status).toBe("exited");
    const exitAudit = store.timeline.find(
      (event) => event.eventType === "run_exited"
    );
    expect(exitAudit?.metadata).toMatchObject({
      reason: "entity_condition_not_met",
      entityType: "appointment",
      checkpoint: "before-node",
      checkedAt: "2026-10-19T15:00:00.000Z",
      nodeId: "second",
    });
    expect(JSON.stringify(store.calls)).not.toContain("appt_secret");
  });

  it("lets a refused terminal write under an Exit claim escape for durable retry", async () => {
    const databaseError = new DatabaseError({
      cause: new Error("terminal unavailable"),
    });
    const store = createRecordingWorkflowStore();
    store.terminationState = {
      status: "running",
      claim: {
        kind: "exit",
        requestedAt: "2026-10-19T15:00:00.000Z",
        reason: "entity_condition_not_met",
        nodeId: "second",
      },
      didWrite: false,
    };
    let terminalWrites = 0;
    store.completeRun = () => {
      terminalWrites += 1;
      return Effect.fail(databaseError);
    };
    const entities = entityPort([
      { outcome: "eligible" },
      { outcome: "eligible" },
    ]);

    await expect(
      executeTestWorkflow(
        executionInput,
        createInMemoryWorkflowRuntime(),
        store,
        actions,
        entities
      )
    ).rejects.toThrow("terminal unavailable");

    expect(terminalWrites).toBe(1);
    expect(store.timeline).toHaveLength(0);
  });

  it("reports the stored Exit claim when this checkpoint lost it", async () => {
    const store = createRecordingWorkflowStore();
    const authoritative = {
      status: "running" as const,
      claim: {
        kind: "exit" as const,
        requestedAt: "2026-10-19T14:59:00.000Z",
        reason: "entity_not_found" as const,
        nodeId: "other_branch",
      },
      didWrite: false,
    };
    store.requestExit = () =>
      Effect.sync(() => {
        store.terminationState = authoritative;
        return authoritative;
      });
    const entities = entityPort([
      {
        outcome: "exit",
        reason: "entity_condition_not_met",
        checkedAt: "2026-10-19T15:00:00.000Z",
      },
    ]);

    const result = await executeTestWorkflow(
      executionInput,
      createInMemoryWorkflowRuntime(),
      store,
      actions,
      entities
    );

    expect(result).toMatchObject({
      status: "exited",
      exit: {
        reason: "entity_not_found",
        nodeId: "other_branch",
      },
    });
  });

  it("does not resolve for a disabled node", async () => {
    const entities = entityPort([{ outcome: "eligible" }]);

    const result = await executeTestWorkflow(
      { ...executionInput, graph: graph({ secondEnabled: false }) },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(result.status).toBe("completed");
    expect(entities.inputs).toHaveLength(1);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("lets an admitted sibling finish but does not check or admit its successor after Exit", async () => {
    let markActionStarted: (() => void) | undefined;
    const actionStarted = new Promise<void>((resolve) => {
      markActionStarted = resolve;
    });
    let releaseAction: (() => void) | undefined;
    const exitClaimed = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const parallelActions: WorkflowActions = {
      ...actions,
      stepFor: (actionType) =>
        actionType === "test/blocking"
          ? () =>
              Effect.promise(async () => {
                markActionStarted?.();
                await exitClaimed;
                return { success: true as const, data: {} };
              })
          : runAction,
    };
    const store = createRecordingWorkflowStore();
    const requestExit = store.requestExit.bind(store);
    store.requestExit = (input) =>
      requestExit(input).pipe(
        Effect.tap(() => Effect.sync(() => releaseAction?.()))
      );
    const checkedNodes: string[] = [];
    const entities: WorkflowEntities = {
      resolveNode: (input) =>
        Effect.promise(async () => {
          checkedNodes.push(input.nodeId);
          if (input.nodeId === "exit_sibling") {
            await actionStarted;
            return {
              decision: {
                outcome: "exit" as const,
                reason: "entity_not_found" as const,
                checkedAt: "2026-10-19T15:00:00.000Z",
              },
              values: {},
            };
          }
          return { decision: { outcome: "eligible" as const }, values: {} };
        }),
    };
    const parallelGraph = createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode(),
        actionNode("already_admitted", true, "test/blocking"),
        actionNode("exit_sibling"),
        actionNode("after_admitted"),
      ],
      edges: [
        {
          id: "to-admitted",
          source: "lifecycle",
          sourceHandle: "started",
          target: "already_admitted",
        },
        {
          id: "to-exit",
          source: "lifecycle",
          sourceHandle: "started",
          target: "exit_sibling",
        },
        {
          id: "after-admitted",
          source: "already_admitted",
          target: "after_admitted",
        },
      ],
    });

    const result = await executeTestWorkflow(
      { ...executionInput, graph: parallelGraph },
      createInMemoryWorkflowRuntime(),
      store,
      parallelActions,
      entities
    );

    expect(result.status).toBe("exited");
    expect(checkedNodes).toEqual(
      expect.arrayContaining(["already_admitted", "exit_sibling"])
    );
    expect(checkedNodes).not.toContain("after_admitted");
    expect(
      store
        .callsOf("startStepLog")
        .map((entry) => entry.nodeId)
        .filter((nodeId) => nodeId === "already_admitted")
    ).toHaveLength(1);
    expect(
      store.callsOf("startStepLog").map((entry) => entry.nodeId)
    ).not.toContain("after_admitted");
  });

  it("does not check nodes on the Canceled side", async () => {
    const store = createRecordingWorkflowStore();
    store.readPendingCancel = () =>
      Effect.succeed({
        eventName: "appointment.canceled",
        payload: { reason: "host request" },
      });
    const entities = entityPort([]);
    const canceledGraph = createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode(["before-node"], ["appointment.canceled"]),
        actionNode("canceled_action"),
      ],
      edges: [
        {
          id: "canceled-edge",
          source: "lifecycle",
          sourceHandle: LIFECYCLE_CANCELED_HANDLE,
          target: "canceled_action",
        },
      ],
    });

    const result = await executeTestWorkflow(
      { ...executionInput, graph: canceledGraph },
      createInMemoryWorkflowRuntime(),
      store,
      actions,
      entities
    );

    expect(result.status).toBe("canceled");
    expect(entities.inputs).toEqual([]);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("resolves referenced Entity data on the Canceled side without Eligibility", async () => {
    const store = createRecordingWorkflowStore();
    store.readPendingCancel = () =>
      Effect.succeed({
        eventName: "appointment.canceled",
        payload: { reason: "host request" },
      });
    const entities = entityPort(
      [{ outcome: "eligible" }],
      [{ name: "Canceled appointment" }]
    );
    const canceledGraph = createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode(["before-node"], ["appointment.canceled"]),
        actionNode("canceled_action", true, "test/action", {
          message: entityNameToken,
        }),
      ],
      edges: [
        {
          id: "canceled-edge",
          source: "lifecycle",
          sourceHandle: LIFECYCLE_CANCELED_HANDLE,
          target: "canceled_action",
        },
      ],
    });

    const result = await executeTestWorkflow(
      { ...executionInput, graph: canceledGraph },
      createInMemoryWorkflowRuntime(),
      store,
      actions,
      entities
    );

    expect(result.status).toBe("canceled");
    expect(entities.inputs).toEqual([
      {
        entityType: "appointment",
        entityId: "appt_secret",
        nodeId: "canceled_action",
        eventName: "appointment.canceled",
        paths: ["name"],
      },
    ]);
    expect(runAction).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Canceled appointment" }),
      expect.anything()
    );
  });

  it("does not recheck an admission-only rule inside the engine", async () => {
    const entities = entityPort([]);

    const result = await executeTestWorkflow(
      {
        ...executionInput,
        graph: graph({ checkpoints: ["before-execution"] }),
      },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(result.status).toBe("completed");
    expect(entities.inputs).toEqual([]);
    expect(runAction).toHaveBeenCalledTimes(2);
  });

  it("turns an operational resolver failure into a failed node and run", async () => {
    const entities: WorkflowEntities = {
      resolveNode: () =>
        Effect.fail({ kind: "failure", message: "Entity host unavailable" }),
    };

    const result = await executeTestWorkflow(
      executionInput,
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    assert(result.kind === "ended");
    expect(result.status).toBe("failed");
    expect(result.error).toBeUndefined();
    expect(runAction).not.toHaveBeenCalled();
  });

  describe("under the replay driver", () => {
    defineEntityEligibilityReplayCases({});
  });

  it("memoizes only referenced Entity values for deterministic replay", async () => {
    const memo = new Map<string, unknown>();
    const entities = entityPort([{ outcome: "eligible" }], [{ name: "Ada" }]);
    const input = {
      ...executionInput,
      graph: entityDataGraph(["before-execution"]),
    };

    await executeTestWorkflow(
      input,
      createInMemoryWorkflowRuntime({ memo }),
      createRecordingWorkflowStore(),
      actions,
      entities
    );
    await executeTestWorkflow(
      input,
      createInMemoryWorkflowRuntime({ memo }),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(entities.inputs).toHaveLength(1);
    expect(JSON.stringify([...memo.values()])).toContain("Ada");
  });

  it("memoizes the decision without persisting Entity State", async () => {
    const memo = new Map<string, unknown>();
    const entities = entityPort([
      { outcome: "eligible" },
      {
        outcome: "exit",
        reason: "entity_not_found",
        checkedAt: "2026-10-19T16:00:00.000Z",
      },
    ]);

    await executeTestWorkflow(
      executionInput,
      createInMemoryWorkflowRuntime({ memo }),
      createRecordingWorkflowStore(),
      actions,
      entities
    );
    await executeTestWorkflow(
      executionInput,
      createInMemoryWorkflowRuntime({ memo }),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(entities.inputs).toHaveLength(2);
    expect(JSON.stringify([...memo.values()])).not.toContain("appt_secret");
  });
});
