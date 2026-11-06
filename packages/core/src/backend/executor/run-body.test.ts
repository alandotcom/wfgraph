/**
 * One run body serving many passes: a version two passes run is read and
 * parsed once. The cases run on native SQLite, whose version read decodes the
 * stored graph from text, which is the cost the cache saves.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, ManagedRuntime, Schema } from "effect";
import * as graphModule from "@wfgraph/shared/graph/graph";
import { defineAction } from "#src/backend/extensions/define-action";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { leasedPass } from "#src/backend/executor/pass";
import { runBody } from "#src/backend/executor/run-body";
import { deliveryBody } from "#src/backend/executor/delivery-body";
import {
  actionNode,
  edge,
  lifecycleNode,
  noDeliveryServices,
  publishWorkflow,
  startScheduledRun,
} from "#src/backend/executor/testing/run-fixtures";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { createRunVersionCache } from "#src/backend/services/executions/run-input";

const actions = createWorkflowActions(
  assembleExtensions({
    actions: [
      defineAction({
        id: "test/send",
        label: "Send",
        description: "Runs one durable step",
        input: Schema.Struct({}),
        handler: async ({ step }) => {
          await step.run("dispatch", () => Promise.resolve(null));
          return { sent: true };
        },
      }),
    ],
  }),
  stubWfGraphRuntime()
);

const GRAPH = graphModule.createSerializedWorkflowGraph({
  nodes: [lifecycleNode(), actionNode("send", "test/send")],
  edges: [edge("entry", "send", "started")],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runBody", () => {
  it("reads and parses a version once for every pass that runs it", async () => {
    const instance = await wfSqlite().open(
      createIntegrationCipher({ key: "c".repeat(64) })
    );
    const runtime = ManagedRuntime.make(instance.repositories);

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          yield* publishWorkflow({
            workflowId: "wf_1",
            versionId: "ver_1",
            graph: GRAPH,
            catalogFingerprint: actions.catalogFingerprint(),
          });
          for (const entityValue of ["entity_1", "entity_2"]) {
            yield* startScheduledRun({
              workflowId: "wf_1",
              versionId: "ver_1",
              entityValue,
              wakeAt: new Date(),
            });
          }
        })
      );
      const parses = vi.spyOn(graphModule, "toWorkflowGraphData");

      const bodies = {
        run: runBody({ actions: () => actions }),
        delivery: deliveryBody(),
      };
      // Counts the version reads that reach the database.
      let versionReads = 0;
      const results = await runtime.runPromise(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const counted = WorkflowRepo.of({
            ...workflows,
            findVersionById: (versionId) => {
              versionReads += 1;
              return workflows.findVersionById(versionId);
            },
          });
          const executions = yield* ExecutionRepo;
          const claimed = yield* executions.claimDue({
            lanes: [{ kind: "run", limit: 2 }],
            workerId: "worker_1",
            leaseMs: 60_000,
            now: new Date(),
          });
          return yield* Effect.forEach(claimed, (row) =>
            leasedPass(row, bodies, {
              workerId: "worker_1",
              now: () => new Date(),
              leaseMs: 60_000,
            }).pipe(Effect.provideService(WorkflowRepo, counted))
          );
        }).pipe(Effect.provide(noDeliveryServices))
      );

      expect(results.map((result) => result.kind)).toEqual(["ended", "ended"]);
      expect(versionReads).toBe(1);
      expect(parses).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
      await instance.close();
    }
  });
});

describe("createRunVersionCache", () => {
  const version = (id: string) => ({
    id,
    workflowId: "wf_1",
    graph: GRAPH,
    catalogFingerprint: "fingerprint",
  });

  it("drops the version used longest ago once it holds its limit", () => {
    const cache = createRunVersionCache(2);
    cache.set(version("ver_1"));
    cache.set(version("ver_2"));
    // Using ver_1 makes ver_2 the one used longest ago.
    expect(cache.get("ver_1")?.id).toBe("ver_1");
    cache.set(version("ver_3"));

    expect(cache.get("ver_2")).toBeUndefined();
    expect(cache.get("ver_1")?.id).toBe("ver_1");
    expect(cache.get("ver_3")?.id).toBe("ver_3");
  });
});
