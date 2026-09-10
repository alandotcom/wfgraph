import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { LIFECYCLE_CANCELED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { WorkflowActions } from "#src/backend/engine/actions";
import type {
  EntityEligibilityDecision,
  WorkflowEntities,
} from "#src/backend/engine/entities";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { executeTestWorkflow } from "#src/backend/engine/test-execution";
import { driveWithReplay } from "#src/backend/engine/testing/replay-runtime";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  waitMigrateSignal,
  waitResumeSignal,
} from "#src/backend/engine/testing/wait-fixtures";

const condition = JSON.stringify({
  version: 2,
  groupLogic: "and",
  groups: [
    {
      id: "group_1",
      logic: "and",
      conditions: [
        {
          id: "condition_1",
          field: "active",
          fieldType: "boolean",
          operator: "is_true",
        },
      ],
    },
  ],
});

function lifecycleNode(
  checkpoints: Array<"before-execution" | "before-node"> = ["before-node"],
  cancelEvents: string[] = [],
  eligibilityCondition = condition
): WorkflowNode {
  return {
    id: "lifecycle",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      type: "lifecycle",
      label: "Lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["appointment.started"],
          cancelEvents,
          concurrency: "unlimited",
          allowManualStart: false,
          trackedEntity: {
            type: "appointment",
            bindings: Object.fromEntries(
              ["appointment.started", ...cancelEvents].map((eventName) => [
                eventName,
                "appointment",
              ])
            ),
          },
          entityEligibility: {
            condition: eligibilityCondition,
            checkpoints,
          },
        },
      },
    },
  };
}

function actionNode(
  id: string,
  enabled = true,
  actionType = "test/action"
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: id,
      enabled,
      config: { actionType },
    },
  };
}

function graph(
  options: {
    secondEnabled?: boolean;
    checkpoints?: Array<"before-execution" | "before-node">;
  } = {}
) {
  return createSerializedWorkflowGraph({
    nodes: [
      lifecycleNode(options.checkpoints),
      actionNode("first"),
      actionNode("second", options.secondEnabled ?? true),
    ],
    edges: [
      {
        id: "lifecycle-first",
        source: "lifecycle",
        sourceHandle: "started",
        target: "first",
      },
      { id: "first-second", source: "first", target: "second" },
    ],
  });
}

function migrationGraph(eligibilityCondition: string) {
  const wait: WorkflowNode = {
    ...actionNode("wait_1", true, "Wait"),
    data: {
      type: "action",
      label: "Wait",
      config: {
        actionType: "Wait",
        waitMode: "event",
        waitFor: [{ event: "appointment.ready" }],
        waitTimeout: "1h",
      },
    },
  };
  return createSerializedWorkflowGraph({
    nodes: [
      lifecycleNode(["before-node"], [], eligibilityCondition),
      actionNode("first"),
      wait,
      actionNode("second"),
    ],
    edges: [
      {
        id: "lifecycle-first",
        source: "lifecycle",
        sourceHandle: "started",
        target: "first",
      },
      { id: "first-wait", source: "first", target: "wait_1" },
      { id: "wait-second", source: "wait_1", target: "second" },
    ],
  });
}

const runAction = vi.fn(() =>
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

function entityPort(
  decisions: EntityEligibilityDecision[]
): WorkflowEntities & { inputs: Array<Record<string, unknown>> } {
  const inputs: Array<Record<string, unknown>> = [];
  return {
    inputs,
    evaluateEligibility: (input) =>
      Effect.sync(() => {
        inputs.push({ ...input });
        const decision = decisions.shift();
        if (!decision) throw new Error("No test Eligibility decision remains");
        return decision;
      }),
  };
}

const executionInput = {
  graph: graph(),
  executionId: "exec_entity",
  workflowId: "workflow_entity",
  workflowVersionId: "version_entity",
  startEventName: "appointment.started",
  entityType: "appointment",
  entityId: "appt_secret",
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
      },
      {
        entityType: "appointment",
        entityId: "appt_secret",
        nodeId: "second",
        condition,
        eventName: "appointment.started",
      },
    ]);
    expect(store.callsOf("admitNode")).toHaveLength(4);
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
    expect(store.callsOf("completeRun")[0]?.status).toBe("exited");
    const exitAudit = store
      .callsOf("recordAuditEvent")
      .find((event) => event.eventType === "run_exited");
    expect(exitAudit?.metadata).toMatchObject({
      reason: "entity_condition_not_met",
      entityType: "appointment",
      checkpoint: "before-node",
      checkedAt: "2026-10-19T15:00:00.000Z",
      nodeId: "second",
    });
    expect(JSON.stringify(store.calls)).not.toContain("appt_secret");
  });

  it("lets a claimed terminal write failure escape for durable retry", async () => {
    const databaseError = new DatabaseError({
      cause: new Error("terminal unavailable"),
    });
    const store = createRecordingWorkflowStore();
    let terminalWrites = 0;
    store.completeRun = () => {
      terminalWrites += 1;
      return terminalWrites === 1
        ? Effect.succeed({
            status: "running" as const,
            claim: {
              kind: "exit" as const,
              requestedAt: "2026-10-19T15:00:00.000Z",
              reason: "entity_condition_not_met" as const,
              nodeId: "second",
            },
            didWrite: false,
          })
        : Effect.fail(databaseError);
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

    expect(terminalWrites).toBe(2);
    expect(store.callsOf("recordAuditEvent")).toHaveLength(0);
  });

  it("does not stop branches when this checkpoint lost the Exit claim", async () => {
    const store = createRecordingWorkflowStore();
    const stopBranches = vi.fn(async () => undefined);
    const runtime = {
      ...createInMemoryWorkflowRuntime(),
      stopBranches,
    };
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
      runtime,
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
    expect(stopBranches).not.toHaveBeenCalled();
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
      evaluateEligibility: (input) =>
        Effect.promise(async () => {
          checkedNodes.push(input.nodeId);
          if (input.nodeId === "exit_sibling") {
            await actionStarted;
            return {
              outcome: "exit" as const,
              reason: "entity_not_found" as const,
              checkedAt: "2026-10-19T15:00:00.000Z",
            };
          }
          return { outcome: "eligible" as const };
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
      evaluateEligibility: () =>
        Effect.fail({ kind: "failure", message: "Entity host unavailable" }),
    };

    const result = await executeTestWorkflow(
      executionInput,
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions,
      entities
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBeUndefined();
    expect(runAction).not.toHaveBeenCalled();
  });

  it("keeps completed checkpoints across Migration and applies the target rule downstream", async () => {
    const migratedCondition = condition.replace(
      '"active"',
      '"remindersEnabled"'
    );
    const store = createRecordingWorkflowStore();
    const entities = entityPort([
      { outcome: "eligible" },
      { outcome: "eligible" },
      { outcome: "eligible" },
    ]);

    const run = await driveWithReplay(
      (runtime) => {
        const migrated = store.callsOf("createWaitState").length > 0;
        return executeTestWorkflow(
          {
            ...executionInput,
            graph: migrationGraph(migrated ? migratedCondition : condition),
            executionId: "exec_wait",
            workflowVersionId: migrated ? "version_2" : "version_1",
          },
          runtime,
          store,
          actions,
          entities
        );
      },
      {
        events: {
          "wait-park-wait_1-0": waitMigrateSignal(),
          "wait-park-wait_1-1": waitResumeSignal({}, "appointment.ready"),
        },
      }
    );

    expect(run.value.status).toBe("completed");
    expect(entities.inputs).toEqual([
      expect.objectContaining({ nodeId: "first", condition }),
      expect.objectContaining({ nodeId: "wait_1", condition }),
      expect.objectContaining({
        nodeId: "second",
        condition: migratedCondition,
      }),
    ]);
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
