/**
 * The Canceled outlet's Wait, over a real database.
 *
 * `core-cancel.test.ts` drives the same graph against the recording store, which
 * models the claim guard rather than running it. This case runs the guard: a
 * Cancel claim written by `requestCancelForEntity` has to admit the park behind
 * the Canceled outlet, or the run halts at that Wait and the Cleanup below it
 * never runs.
 */

import { describe, expect, it } from "vitest";
import { Effect, ManagedRuntime, Schema } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { unknownRest } from "@wfgraph/shared/types/schema";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { defineAction } from "#src/backend/extensions/define-action";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { createDbWorkflowStore } from "#src/backend/engine/db-store";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

const RECORDER_ACTION_ID = "test/sqlite-cancel-recorder";

const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });
const cipher = createIntegrationCipher({ key: "c".repeat(64) });

const actions = createWorkflowActions(
  assembleExtensions({
    actions: [
      defineAction({
        id: RECORDER_ACTION_ID,
        label: "Recorder",
        description: "Records the config it was handed",
        input: Schema.StructWithRest(Schema.Struct({}), unknownRest),
        handler: ({ input }) => ({ seen: String(input.label ?? "") }),
      }),
    ],
  }),
  stubWfGraphRuntime()
);

/**
 * Started: one Recorder. Canceled: a one-hour Wait, then a Recorder reading the
 * payload the canceling Event carried.
 */
const graph = createSerializedWorkflowGraph({
  nodes: [
    {
      id: "lifecycle_1",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        label: "Lifecycle",
        type: "lifecycle",
        config: {
          lifecycleRules: {
            startEvents: ["app/appointment.created"],
            cancelEvents: ["app/appointment.canceled"],
            concurrency: "unlimited",
          },
        },
      },
    },
    {
      id: "after_1",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "After",
        type: "action",
        config: { actionType: RECORDER_ACTION_ID, label: "After" },
      },
    },
    {
      id: "grace_1",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Grace Period",
        type: "action",
        config: { actionType: "Wait", waitMode: "delay", waitDuration: "1h" },
      },
    },
    {
      id: "cleanup_1",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Cleanup",
        type: "action",
        config: {
          actionType: RECORDER_ACTION_ID,
          label: "Cleanup",
          reason: "{{@lifecycle_1:Lifecycle.reason}}",
        },
      },
    },
  ],
  edges: [
    {
      id: "edge_started",
      source: "lifecycle_1",
      sourceHandle: "started",
      target: "after_1",
    },
    {
      id: "edge_canceled",
      source: "lifecycle_1",
      sourceHandle: "canceled",
      target: "grace_1",
    },
    { id: "edge_cleanup", source: "grace_1", target: "cleanup_1" },
  ],
});

describe("a Canceled-side Wait over native SQLite", () => {
  it("parks behind the Canceled outlet under the run's own Cancel claim", async () => {
    const instance = await wfSqlite().open(cipher);
    const runtime = ManagedRuntime.make(instance.repositories);

    try {
      const executionId = await runtime.runPromise(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_1",
            version: 1,
            expectedPublishedVersionId: null,
            expectedDraftRevision: 1,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "digest",
            eventSubscriptions: [],
          });

          const executions = yield* ExecutionRepo;
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "event",
              runMode: "live",
              entityValue: "appointment_1",
              input: { reason: "started normally" },
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started") {
            throw new Error("Start was refused");
          }

          // The Cancel Event claims the run without ending it, which is what
          // sends it down the Canceled outlet at its next node boundary.
          yield* executions.requestCancelForEntity({
            workflowId: "wf_1",
            entityValue: "appointment_1",
            runMode: "live",
            eventName: "app/appointment.canceled",
            payload: { reason: "customer left" },
          });

          return started.execution.id;
        })
      );

      const store = createDbWorkflowStore(
        await runtime.runPromise(ExecutionRepo)
      );

      const result = await executeWorkflow(
        {
          graph,
          executionId,
          workflowId: "wf_1",
          workflowVersionId: "ver_1",
          startPayload: { reason: "started normally" },
        },
        createInMemoryWorkflowRuntime(),
        store,
        actions
      );

      const rows = await runtime.runPromise(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const timeline = yield* executions.listEvents(executionId);
          return {
            // `listEvents` answers newest first, and the park reads better in
            // the order it happened.
            waitTimeline: timeline
              .toReversed()
              .filter(
                (event) =>
                  event.eventType === "run_waiting" ||
                  event.eventType === "run_resumed"
              )
              .map((event) => [
                event.eventType,
                readJsonObject(event.metadata)?.nodeId,
              ]),
            status: (yield* executions.findStatusById(executionId))?.status,
            outputs: yield* executions.readNodeOutputs(executionId),
          };
        })
      );

      expect(result.status).toBe("canceled");
      expect(rows.status).toBe("canceled");
      // The park was written and then resumed, which is the whole question: the
      // run's own Cancel claim admits a Canceled-side park, where the same park
      // on the Started side is refused.
      expect(rows.waitTimeline).toEqual([
        ["run_waiting", "grace_1"],
        ["run_resumed", "grace_1"],
      ]);
      expect(Object.keys(rows.outputs)).toContain("cleanup_1");
    } finally {
      await runtime.dispose();
      await instance.close();
    }
  });
});
