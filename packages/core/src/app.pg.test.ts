/**
 * The runner on PostgreSQL: the loop `createWfGraphApp` starts listens for the
 * runs other processes make due, and dispose stops listening after the loop
 * has drained and before the database closes. `createWfGraphRunner` advances
 * the runs of an app that runs no loop of its own.
 */

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { createWfGraphApp, type WfGraphAppOptions } from "#src/app";
import { defineAction, defineEvent, trustWfGraphUpstream } from "#src/index";
import { createWfGraphRunner } from "#src/runner";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import {
  actionNode,
  edge,
  lifecycleNode,
  publishWorkflow,
  startScheduledRun,
} from "#src/backend/executor/testing/run-fixtures";
import { recordedLogger } from "#src/backend/executor/testing/recorded-logger";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { catalogFingerprint } from "#src/backend/services/workflows/version-digest";
import { migrateWfGraphDatabase } from "#src/migrate";
import * as workerLoopModule from "#src/backend/executor/worker-loop";
import { wfPostgres } from "#src/backend/persistence/postgres";
import {
  describePostgres,
  mintTestSchemaName,
  requirePostgresTestUrl,
  withAdminClient,
} from "#src/backend/persistence/postgres-test-database";
import type { WfGraphPersistence } from "#src/backend/persistence/types";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";

const ENCRYPTION = { key: "b".repeat(64) };

describePostgres("createWfGraphApp runner on PostgreSQL", () => {
  let url: string;
  let schema: string;

  beforeAll(async () => {
    url = requirePostgresTestUrl();
    schema = mintTestSchemaName();
    await migrateWfGraphDatabase({ url, schema });
  });

  afterAll(async () => {
    await withAdminClient(async (client) => {
      await client.unsafe(`drop schema if exists "${schema}" cascade`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The PostgreSQL backend with its listener and its close observed: each
   * step lands in `events`, and `heard` counts the notifications the app's
   * listener heard.
   */
  function observedPostgres(events: string[]) {
    let heard = 0;
    const listening = Promise.withResolvers<void>();
    const persistence: WfGraphPersistence = {
      open: async (cipher) => {
        const instance = await wfPostgres({ url, schema }).open(cipher);
        const { capabilities } = instance;
        const { broadcast } = capabilities;
        if (broadcast === undefined) throw new Error("Expected a broadcast");
        return {
          ...instance,
          capabilities: {
            ...capabilities,
            broadcast: {
              ...broadcast,
              listen: async (onWake) => {
                const listener = await broadcast.listen(() => {
                  heard += 1;
                  onWake();
                });
                events.push("listening");
                listening.resolve();
                return {
                  stop: async () => {
                    events.push("listener stopped");
                    await listener.stop();
                  },
                };
              },
            },
          },
          close: async () => {
            events.push("persistence closed");
            await instance.close();
          },
        };
      },
    };
    return { persistence, listening: listening.promise, heard: () => heard };
  }

  it("listens for other processes' wakes and stops after the loop drains", async () => {
    const events: string[] = [];
    const runWorkerLoop = workerLoopModule.runWorkerLoop;
    vi.spyOn(workerLoopModule, "runWorkerLoop").mockImplementation((options) =>
      runWorkerLoop(options).pipe(
        Effect.ensuring(Effect.sync(() => events.push("loop ended")))
      )
    );
    const observed = observedPostgres(events);

    const app = await createWfGraphApp({
      auth: trustWfGraphUpstream(),
      persistence: observed.persistence,
      encryption: ENCRYPTION,
    });
    await observed.listening;

    // Another process on the same schema announces a row it made due.
    const other = await wfPostgres({ url, schema }).open(
      createIntegrationCipher(ENCRYPTION)
    );
    try {
      const { broadcast } = other.capabilities;
      if (broadcast === undefined) throw new Error("Expected a broadcast");
      broadcast.announce();
      await vi.waitFor(() => expect(observed.heard()).toBe(1), {
        timeout: 2_000,
      });
    } finally {
      await other.close();
    }

    await app.dispose();
    expect(events).toEqual([
      "listening",
      "loop ended",
      "listener stopped",
      "persistence closed",
    ]);
  });

  const markAction = defineAction({
    id: "test/mark",
    label: "Mark",
    description: "Completes at once",
    input: Schema.Struct({}),
    handler: () => ({}),
  });

  /**
   * Publishes a workflow whose one action is `markAction` and schedules one
   * run of it due now, through a connection of the case's own, the way an
   * app with no loop of its own leaves a run for the runner. Answers how to
   * read that run's status back.
   */
  async function seedDueRun(id: string) {
    const instance = await wfPostgres({ url, schema }).open(
      createIntegrationCipher(ENCRYPTION)
    );
    const runtime = ManagedRuntime.make(instance.repositories);
    const executionId = await runtime.runPromise(
      Effect.gen(function* () {
        yield* publishWorkflow({
          workflowId: `wf_${id}`,
          versionId: `ver_${id}`,
          graph: createSerializedWorkflowGraph({
            nodes: [lifecycleNode(), actionNode("mark", "test/mark")],
            edges: [edge("entry", "mark", "started")],
          }),
          catalogFingerprint: catalogFingerprint(
            assembleExtensions({ actions: [markAction] }).catalog
          ),
        });
        return yield* startScheduledRun({
          workflowId: `wf_${id}`,
          versionId: `ver_${id}`,
          entityValue: `entity_${id}`,
          wakeAt: new Date(),
        });
      })
    );
    return {
      status: () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return (yield* executions.findSummaryById(executionId))?.status;
          })
        ),
      close: async () => {
        await runtime.dispose();
        await instance.close();
      },
    };
  }

  // The arrangement docs/embedding.md documents: one options object, handed
  // to the app with `runner: false` and to the runner as it is.
  it("advances a run in createWfGraphRunner beside an app with runner: false", async () => {
    const loops = vi.spyOn(workerLoopModule, "runWorkerLoop");
    const recorded = recordedLogger();
    const options: WfGraphAppOptions = {
      auth: trustWfGraphUpstream(),
      persistence: wfPostgres({ url, schema }),
      encryption: ENCRYPTION,
      extensions: { actions: [markAction] },
      logger: recorded.logger,
    };
    const app = await createWfGraphApp({ ...options, runner: false });
    expect(loops).not.toHaveBeenCalled();

    const seeded = await seedDueRun("runner_entry");
    try {
      await using runner = await createWfGraphRunner(options);
      await vi.waitFor(
        async () => expect(await seeded.status()).toBe("completed"),
        { timeout: 5_000 }
      );
      expect(loops).toHaveBeenCalledTimes(1);
      await runner.dispose();
      expect(recorded.find("Worker loop stopped")).toHaveLength(1);
    } finally {
      await seeded.close();
      await app.dispose();
    }
  });

  // The statement inboxInsert answers is the documented one, qualified with
  // the app's schema, and a host's own transaction on its own connection
  // stores an arrival the app's loop then delivers.
  it("answers an inbox insert a host transaction runs, which the loop delivers", async () => {
    const paymentSettled = defineEvent({
      name: "billing/payment.settled",
      schema: Schema.Struct({ appointmentId: Schema.String }),
    });
    await using app = await createWfGraphApp({
      auth: trustWfGraphUpstream(),
      persistence: wfPostgres({ url, schema }),
      encryption: ENCRYPTION,
      extensions: { events: [paymentSettled] },
    });

    const insert = await app.events.inboxInsert(
      paymentSettled,
      { appointmentId: "appt_pg" },
      { id: "settled_pg" }
    );
    expect(insert.params).toEqual([
      paymentSettled.name,
      { appointmentId: "appt_pg" },
      "settled_pg",
    ]);
    expect(insert.sql).toBe(
      `insert into ${schema}.workflow_event_inbox (name, data, idempotency_key)\nvalues ($1, $2, $3)\non conflict do nothing`
    );

    const statusOf = () =>
      withAdminClient(async (client) => {
        const rows = await client.unsafe(
          `select status, data from ${schema}.workflow_event_inbox where idempotency_key = $1`,
          ["settled_pg"]
        );
        return rows.map((row) => ({ status: row.status, data: row.data }));
      });
    await withAdminClient(async (client) => {
      await client.begin(async (transaction) => {
        await transaction.unsafe(insert.sql, [...insert.params]);
        await transaction.unsafe(insert.sql, [...insert.params]);
      });
    });

    await vi.waitFor(
      async () =>
        expect(await statusOf()).toEqual([
          { status: "delivered", data: { appointmentId: "appt_pg" } },
        ]),
      { timeout: 5_000 }
    );
  });

  it("refuses to start a runner whose Layer graph fails to build, and closes the database", async () => {
    const loops = vi.spyOn(workerLoopModule, "runWorkerLoop");
    let closed = 0;
    await expect(
      createWfGraphRunner({
        encryption: ENCRYPTION,
        persistence: {
          open: async (cipher) => {
            const instance = await wfPostgres({ url, schema }).open(cipher);
            return {
              ...instance,
              repositories: Layer.merge(
                instance.repositories,
                Layer.effectDiscard(Effect.die(new Error("graph refused")))
              ),
              close: async () => {
                closed += 1;
                await instance.close();
              },
            };
          },
        },
      })
    ).rejects.toThrow("graph refused");

    expect(loops).not.toHaveBeenCalled();
    expect(closed).toBe(1);
  });

  it("stops at once when its listener never connected", async () => {
    const runner = await createWfGraphRunner({
      encryption: ENCRYPTION,
      persistence: {
        open: async (cipher) => {
          const instance = await wfPostgres({ url, schema }).open(cipher);
          const { broadcast } = instance.capabilities;
          if (broadcast === undefined) throw new Error("Expected a broadcast");
          return {
            ...instance,
            capabilities: {
              ...instance.capabilities,
              broadcast: {
                ...broadcast,
                // A database that never answers the LISTEN.
                listen: () => new Promise(() => {}),
              },
            },
          };
        },
      },
    });
    const startedAt = Date.now();
    await runner.dispose();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
