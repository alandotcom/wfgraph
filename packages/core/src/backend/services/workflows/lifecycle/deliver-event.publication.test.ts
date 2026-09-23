import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { deriveEventSubscriptions } from "#src/backend/services/workflows/lifecycle/subscriptions";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { applyLifecycleRules } from "#src/backend/services/workflows/lifecycle/deliver-event";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

const EVENT_NAME = "app/appointment.created";
const WORKFLOW_ID = "wf_publication_race";
const CIPHER = createIntegrationCipher({ key: "c".repeat(64) });

function lifecycleNodes(correlationPath: string) {
  return [
    {
      id: "lifecycle-1",
      position: { x: 0, y: 0 },
      data: {
        label: "Start",
        type: "lifecycle" as const,
        config: {
          lifecycleRules: {
            startEvents: [EVENT_NAME],
            cancelEvents: [],
            concurrency: "first-wins" as const,
            correlationPaths: { [EVENT_NAME]: correlationPath },
          },
        },
      },
    },
  ];
}

function workflowGraph(correlationPath: string) {
  return createSerializedWorkflowGraph({
    nodes: lifecycleNodes(correlationPath),
    edges: [],
  });
}

describe("published Event metadata on native SQLite", () => {
  it("starts from the path on the same version the Execution pins", async () => {
    const instance = await wfSqlite().open(CIPHER);
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        instance.repositories,
        SilentAppLoggerLayer,
        stubExtensionCatalog({
          events: [
            {
              name: EVENT_NAME,
              label: "Appointment created",
              correlationPath: "declared.id",
              payloadFields: [
                { path: "declared.id", type: "string" },
                { path: "old.id", type: "string" },
                { path: "current.id", type: "string" },
              ],
            },
          ],
        }),
        stubInngestClient({
          sendRunRequested: () => Effect.succeed({ eventId: "evt_1" }),
        })
      )
    );

    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const workflow = yield* workflows.insert({
            id: WORKFLOW_ID,
            name: "Appointment reminders",
            graph: workflowGraph("old.id"),
            eventSubscriptions: deriveEventSubscriptions({
              workflowId: WORKFLOW_ID,
              nodes: lifecycleNodes("old.id"),
            }),
          });
          const graphV1 = workflowGraph("old.id");
          const v1Subscriptions = deriveEventSubscriptions({
            workflowId: WORKFLOW_ID,
            nodes: lifecycleNodes("old.id"),
          });
          const v1 = yield* workflows.insertPublishedVersion({
            workflowId: WORKFLOW_ID,
            versionId: "ver_1",
            version: 1,
            expectedPublishedVersionId: null,
            expectedDraftRevision: workflow.draftRevision,
            graph: graphV1,
            catalogFingerprint: "catalog",
            graphDigest: "graph_1",
            draftGraph: graphV1,
            eventSubscriptions: v1Subscriptions,
          });
          if (!v1 || "stale" in v1 || "draftConflict" in v1) {
            throw new Error("Could not publish v1");
          }

          const [staleSubscriber] =
            yield* workflows.listEventSubscribers(EVENT_NAME);
          if (!staleSubscriber) {
            throw new Error("v1 subscriber was not indexed");
          }

          const graphV2 = workflowGraph("current.id");
          const v2 = yield* workflows.insertPublishedVersion({
            workflowId: WORKFLOW_ID,
            versionId: "ver_2",
            version: 2,
            expectedPublishedVersionId: "ver_1",
            expectedDraftRevision: 2,
            graph: graphV2,
            catalogFingerprint: "catalog",
            graphDigest: "graph_2",
            draftGraph: graphV2,
            eventSubscriptions: deriveEventSubscriptions({
              workflowId: WORKFLOW_ID,
              nodes: lifecycleNodes("current.id"),
            }),
          });
          if (!v2 || "stale" in v2 || "draftConflict" in v2) {
            throw new Error("Could not publish v2");
          }

          const outcome = yield* applyLifecycleRules({
            subscriber: staleSubscriber,
            event: { name: EVENT_NAME, correlationPath: "declared.id" },
            payload: {
              declared: { id: "declared-entity" },
              old: { id: "old-entity" },
              current: { id: "current-entity" },
            },
          });
          const executions = yield* ExecutionRepo;
          const runs = yield* executions.listByWorkflow({
            workflowId: WORKFLOW_ID,
            includeSuperseded: false,
          });

          return { staleSubscriber, outcome, runs };
        })
      );

      expect(result.staleSubscriber.correlationPath).toBe("old.id");
      expect(result.outcome.kind).toBe("started");
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]).toMatchObject({
        entityValue: "current-entity",
        versionNumber: 2,
      });
    } finally {
      await runtime.dispose();
      await instance.close();
    }
  });
});
