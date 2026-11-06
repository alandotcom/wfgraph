/**
 * The Entity Eligibility fixtures, and the case the Entity Eligibility suite
 * runs under the replay driver: checkpoints completed before a Migration keep their
 * rule, and the nodes after it are checked against the target version's.
 */

import { expect, it } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { WorkflowActions } from "#src/backend/engine/actions";
import type {
  EntityEligibilityDecision,
  WorkflowEntities,
} from "#src/backend/engine/entities";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { executeTestWorkflow } from "#src/backend/engine/test-execution";
import {
  driveWithReplay,
  type ReplayExecutor,
} from "#src/backend/engine/testing/replay-runtime";
import {
  migrateWake,
  resumeWake,
} from "#src/backend/engine/testing/wait-fixtures";

export const condition = JSON.stringify({
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

export function lifecycleNode(
  checkpoints: Array<"before-execution" | "before-node"> = ["before-node"],
  cancelEvents: string[] = [],
  eligibilityCondition: string | null = condition
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
          ...(eligibilityCondition
            ? {
                entityEligibility: {
                  condition: eligibilityCondition,
                  checkpoints,
                },
              }
            : {}),
        },
      },
    },
  };
}

export function actionNode(
  id: string,
  enabled = true,
  actionType = "test/action",
  config: Record<string, unknown> = {}
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: id,
      enabled,
      config: { actionType, ...config },
    },
  };
}

export function graph(
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

export function entityPort(
  decisions: EntityEligibilityDecision[],
  values: JsonObject[] = []
): WorkflowEntities & { inputs: Array<Record<string, unknown>> } {
  const inputs: Array<Record<string, unknown>> = [];
  return {
    inputs,
    resolveNode: (input) =>
      Effect.sync(() => {
        inputs.push({ ...input });
        const decision = decisions.shift();
        if (!decision) throw new Error("No test Eligibility decision remains");
        return { decision, values: values.shift() ?? {} };
      }),
  };
}

export const executionInput = {
  graph: graph(),
  executionId: "exec_entity",
  workflowId: "workflow_entity",
  workflowVersionId: "version_entity",
  startEventName: "appointment.started",
  entityType: "appointment",
  entityId: "appt_secret",
};

/** An action that succeeds with no output. */
const succeedingActions: WorkflowActions = {
  stepFor: () => () => Effect.succeed({ success: true as const, data: {} }),
  metadataFor: () => ({
    label: "Test action",
    literalConfigKeys: [],
    templateJsonConfigShapes: [],
  }),
  catalogFingerprint: () => "catalog",
};

export function defineEntityEligibilityReplayCases(
  executor: ReplayExecutor
): void {
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
          succeedingActions,
          entities
        );
      },
      {
        events: {
          "wait-park-wait_1-0": migrateWake(),
          "wait-park-wait_1-1": resumeWake({}, "appointment.ready"),
        },
        executor,
        waitRows: store,
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
}
