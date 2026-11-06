import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { createWorkerWake } from "#src/backend/executor/worker-wake";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import { SilentAppLoggerLayer } from "#src/backend/lib/effect/test-layers";
import { makeExecutionDriverLayer } from "#src/backend/services/executions/driver";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  deliverWaitCandidates,
  listWaitCandidatePage,
} from "#src/backend/services/workflows/lifecycle/deliver-event";

// The claim and the wake are one write on a real SQLite database, through the
// real `ExecutionDriver`. A park taken by one arrival holds that arrival, so a
// second arrival takes nothing, and a retry of the first counts the run it
// already woke without writing a second wake. With a rotated token the saved
// candidate is stale, and the delivery re-reads the row and claims it under the
// token it holds now.
it.each([false, true])(
  "claims a park once for its first arrival, with a rotated token: %s",
  async (rotateToken) => {
    const instance = await wfSqlite().open(
      createIntegrationCipher({ key: "c".repeat(64) })
    );
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        SilentAppLoggerLayer,
        makeExecutionDriverLayer({
          worker: createWorkerWake(),
          persistence: instance.wakes,
        }).pipe(Layer.provideMerge(instance.repositories))
      )
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          const graph = createSerializedWorkflowGraph({ nodes: [], edges: [] });
          const workflow = yield* workflows.insert({
            id: "wait-retry",
            name: "Wait retry",
            graph,
            eventSubscriptions: [],
          });
          const version = yield* workflows.insertPublishedVersion({
            workflowId: workflow.id,
            versionId: "wait-retry-v1",
            version: 1,
            expectedPublishedVersionId: null,
            expectedDraftRevision: workflow.draftRevision,
            graph,
            draftGraph: graph,
            catalogFingerprint: "catalog",
            graphDigest: "graph",
            eventSubscriptions: [],
          });
          if (!version || "stale" in version || "draftConflict" in version) {
            throw new Error("Could not publish fixture");
          }
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: workflow.id,
              workflowVersionId: "wait-retry-v1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "replaced",
          });
          if (started.status !== "started") throw new Error("Start refused");
          const metadata = { waitFor: [{ event: "approval" }] };
          const wait = yield* executions.startWait({
            executionId: started.execution.id,
            workflowId: workflow.id,
            workflowVersionId: "wait-retry-v1",
            runId: "branch",
            nodeId: "wait",
            nodeName: "Wait",
            side: "started",
            waitType: "event",
            resumeToken: "original-token",
            subscribedEvents: ["approval"],
            metadata,
          });
          if (!wait) throw new Error("Wait refused");
          const page = yield* listWaitCandidatePage({
            workflowId: workflow.id,
            eventName: "approval",
            excludingExecutionIds: [],
          });
          if (rotateToken) {
            const repark = yield* executions.reparkWait({
              waitStateId: wait.waitStateId,
              workflowVersionId: "wait-retry-v1",
              side: "started",
              waitType: "event",
              waitUntil: null,
              resumeToken: "rotated-token",
              subscribedEvents: ["approval"],
              metadata,
            });
            expect(repark).toEqual({ ok: true });
          }
          const deliver = (deliveryId: string) =>
            deliverWaitCandidates({
              workflowId: workflow.id,
              event: { name: "approval" },
              payload: { owner: deliveryId },
              candidates: page.candidates,
              deliveryId,
            });

          expect((yield* deliver("owner")).resumedWaits).toBe(1);
          expect((yield* deliver("other")).resumedWaits).toBe(0);
          expect((yield* deliver("owner")).resumedWaits).toBe(1);

          const claimed = yield* executions.findWaitStateById(wait.waitStateId);
          expect(claimed?.status).toBe("resuming");
          expect(claimed?.metadata?.arrival).toMatchObject({
            deliveryId: "owner",
            payload: { owner: "owner" },
          });
          const park = yield* executions.findPark(wait.waitStateId);
          expect(park?.wake).toEqual({
            kind: "resume",
            eventName: "approval",
            payload: { owner: "owner" },
            deliveryId: "owner",
          });
        })
      );
    } finally {
      await runtime.dispose();
      await instance.close();
    }
  }
);
