import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it, vi } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import {
  SilentAppLoggerLayer,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import {
  InngestError,
  type InngestClient,
} from "#src/backend/lib/effect/inngest-client";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  deliverWaitCandidates,
  listWaitCandidatePage,
} from "#src/backend/services/workflows/lifecycle/deliver-event";

it.each([false, true])(
  "preserves another arrival and retries its owner with a rotated token: %s",
  async (rotateToken) => {
    const instance = await wfSqlite().open(
      createIntegrationCipher({ key: "c".repeat(64) })
    );
    const send = vi
      .fn<InngestClient["Service"]["sendWaitSignal"]>(() => Effect.void)
      .mockImplementationOnce(() =>
        Effect.fail(new InngestError({ cause: "send failed" }))
      );
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        instance.repositories,
        SilentAppLoggerLayer,
        stubInngestClient({ sendWaitSignal: send })
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

          const first = yield* deliver("owner").pipe(Effect.flip);
          expect(first).toBeInstanceOf(InngestError);
          expect((yield* deliver("other")).resumedWaits).toBe(0);
          const pending = yield* executions.findWaitStateById(wait.waitStateId);
          expect(pending?.metadata?.arrival).toMatchObject({
            deliveryId: "owner",
            payload: { owner: "owner" },
          });
          expect((yield* deliver("owner")).resumedWaits).toBe(1);
          expect(send).toHaveBeenCalledTimes(2);
          const settled = yield* executions.findWaitStateById(wait.waitStateId);
          expect(settled?.status).toBe("resumed");
        })
      );
    } finally {
      await runtime.dispose();
      await instance.close();
    }
  }
);
