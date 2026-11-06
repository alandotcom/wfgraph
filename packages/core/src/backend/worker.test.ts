/**
 * The Cloudflare Worker entry with the platform's objects stubbed: `fetch`
 * opening and closing persistence per request, and the `scheduled` and
 * `queue` handlers running a tick on native SQLite, with and without a Queue
 * carrying the run wakes.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import {
  defineWfGraphAuth,
  trustWfGraphUpstream,
  WfGraphAccess,
  wfWorker,
  type WfGraphWakeMessage,
  type WfGraphWakeQueue,
  type WfGraphWorker,
  type WfGraphWorkerOptions,
} from "#src/worker";
import type {
  WfGraphPersistence,
  WfGraphPersistenceInstance,
} from "#src/backend/persistence/types";
import { defineAction } from "#src/backend/extensions/define-action";
import { defineEvent } from "#src/backend/extensions/define-event";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import {
  stubExecutionRepo,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  actionNode,
  edge,
  lifecycleNode,
  publishWorkflow,
} from "#src/backend/executor/testing/run-fixtures";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { catalogFingerprint } from "#src/backend/services/workflows/version-digest";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import type { WfGraphRepositories } from "#src/backend/runtime";

const ENCRYPTION = { key: "d".repeat(64) };
const EVENTS_KEY = "events-key-0123456789";

/** A backend serving the given repositories, which opens no database. */
function stubPersistence(
  repositories: WfGraphPersistenceInstance["repositories"],
  close: () => Promise<void> = () => Promise.resolve()
): WfGraphPersistence {
  return {
    open: async () => ({
      repositories,
      capabilities: {
        connectionLimit: 1,
        processes: "many",
        loopDefaults: { concurrency: 1 },
      },
      description: { backend: "test" },
      close,
    }),
  };
}

const stubRepositories = () =>
  Layer.mergeAll(
    stubExecutionRepo(),
    stubIntegrationRepo(),
    stubWorkflowRepo()
  );

/** Records every message a Worker sends, as a Queue producer binding would take it. */
function recordingQueue(): WfGraphWakeQueue & {
  sent: WfGraphWakeMessage[];
} {
  const sent: WfGraphWakeMessage[] = [];
  return {
    sent,
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

describe("wfWorker", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("keeps one environment type while auth closes over arbitrary session state", () => {
    type WorkerEnv = {
      INTEGRATION_ENCRYPTION_KEY: string;
      WFGRAPH_WAKES: WfGraphWakeQueue;
    };
    type HostSession = { organizationId: string; grants: ReadonlySet<string> };

    const session: HostSession = {
      organizationId: "org-1",
      grants: new Set(["workflow.read"]),
    };
    const auth = defineWfGraphAuth(async () => {
      await Promise.resolve();
      return {
        allows: (operation) =>
          session.organizationId === "org-1" &&
          session.grants.has(operation.permission),
      };
    });
    const persistence = undefined as unknown as WfGraphPersistence;
    const options: WfGraphWorkerOptions<WorkerEnv> = {
      request: (env) => ({
        auth,
        persistence,
        encryption: { key: env.INTEGRATION_ENCRYPTION_KEY },
        wakeQueue: env.WFGRAPH_WAKES,
      }),
    };

    expectTypeOf(options).toExtend<Parameters<typeof wfWorker<WorkerEnv>>[0]>();
    expectTypeOf(wfWorker<WorkerEnv>).returns.toEqualTypeOf<
      WfGraphWorker<WorkerEnv>
    >();
    // The handlers take what Cloudflare passes them, so the Worker is the
    // module's default export as it stands.
    expectTypeOf<
      Parameters<WfGraphWorker<WorkerEnv>["scheduled"]>[0]
    >().toEqualTypeOf<{ readonly cron: string }>();
    expect(WfGraphAccess.all.allows).toBeTypeOf("function");
  });

  it("rejects invalid Entity resolver timeouts at startup", () => {
    expect(() =>
      wfWorker({
        entityResolverTimeoutMs: 0,
        extensions: () => ({}),
        request: () => {
          throw new Error("unused");
        },
      })
    ).toThrow("entityResolverTimeoutMs must be a positive integer");
  });

  it("refuses an events option no invocation could run with, before it opens persistence", async () => {
    let opened = 0;
    const persistence: WfGraphPersistence = {
      open: async (cipher) => {
        opened += 1;
        return await stubPersistence(stubRepositories()).open(cipher);
      },
    };
    const worker = (events: { key?: string; retentionMs?: number }) =>
      wfWorker({
        request: () => ({
          auth: trustWfGraphUpstream(),
          persistence,
          encryption: ENCRYPTION,
          events,
        }),
      });

    await expect(
      worker({ key: " " }).fetch(
        new Request("https://example.test/api/extensions"),
        {}
      )
    ).rejects.toThrow("wfWorker's events.key is blank");
    await expect(
      worker({ retentionMs: 0 }).scheduled({ cron: "* * * * *" }, {})
    ).rejects.toThrow(
      "wfWorker's events.retentionMs must be a positive integer"
    );
    expect(opened).toBe(0);
  });

  it("resolves request-scoped extensions from the Worker environment", async () => {
    let resolutions = 0;
    const worker = wfWorker({
      extensions: (env: { integrationType: string }) => {
        resolutions += 1;
        return {
          integrations: [
            defineIntegration({
              type: env.integrationType,
              label: env.integrationType,
              description: "Request-scoped integration",
              credentials: {},
              actions: {},
            }),
          ],
        };
      },
      request: () => ({
        auth: trustWfGraphUpstream(),
        persistence: stubPersistence(stubRepositories()),
        encryption: ENCRYPTION,
      }),
    });

    const first = await worker.fetch(
      new Request("https://example.test/api/extensions"),
      { integrationType: "first" }
    );
    const second = await worker.fetch(
      new Request("https://example.test/api/extensions"),
      { integrationType: "second" }
    );
    const firstBody = (await first.json()) as {
      catalog: { integrations: Array<{ type: string }> };
    };
    const secondBody = (await second.json()) as {
      catalog: { integrations: Array<{ type: string }> };
    };

    expect(firstBody.catalog.integrations.map(({ type }) => type)).toEqual([
      "first",
    ]);
    expect(secondBody.catalog.integrations.map(({ type }) => type)).toEqual([
      "second",
    ]);
    expect(resolutions).toBe(2);
  });

  it("opens and closes persistence for each request", async () => {
    directory = await mkdtemp(join(tmpdir(), "wfgraph-worker-"));
    const sqlite = wfSqlite({ filename: join(directory, "wfgraph.db") });
    let opened = 0;
    let closed = 0;
    const persistence: WfGraphPersistence = {
      open: async (cipher) => {
        opened += 1;
        const instance = await sqlite.open(cipher);
        return {
          ...instance,
          close: async () => {
            closed += 1;
            await instance.close();
          },
        };
      },
    };
    const worker = wfWorker({
      request: () => ({
        auth: trustWfGraphUpstream(),
        persistence,
        encryption: ENCRYPTION,
      }),
    });

    const first = await worker.fetch(
      new Request("https://example.test/api/extensions"),
      {}
    );
    const second = await worker.fetch(
      new Request("https://example.test/api/extensions"),
      {}
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(opened).toBe(2);
    expect(closed).toBe(2);
  });

  it("keeps request resources open until a streaming response is canceled", async () => {
    let reads = 0;
    let closed = 0;
    const repositories = Layer.mergeAll(
      stubExecutionRepo(),
      stubIntegrationRepo(),
      stubWorkflowRepo({
        listSummariesNewestFirst: Effect.sync(() => {
          reads += 1;
          return [
            {
              id: "wf_1",
              name: reads === 1 ? "First" : "Second",
              description: null,
              isPaused: false,
              mode: "live",
              visibility: "private",
              publishedVersionId: null,
              createdAt: new Date("2026-09-04T09:00:00.000Z"),
              updatedAt: new Date(
                reads === 1
                  ? "2026-09-04T09:00:00.000Z"
                  : "2026-09-04T10:00:00.000Z"
              ),
            },
          ];
        }),
      })
    );
    const worker = wfWorker({
      request: () => ({
        auth: trustWfGraphUpstream(),
        persistence: stubPersistence(repositories, async () => {
          closed += 1;
        }),
        encryption: ENCRYPTION,
      }),
    });

    const response = await worker.fetch(
      new Request("https://example.test/api/rpc/workflow/subscribeList", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      {}
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    const decoder = new TextDecoder();
    let body = "";
    while ((body.match(/data: /g) ?? []).length < 2) {
      // The list stream polls serially, so each response chunk must be read in order.
      // eslint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      body += decoder.decode(chunk.value, { stream: true });
    }

    expect(closed).toBe(0);
    expect(body).toContain('"name":"First"');
    expect(body).toContain('"name":"Second"');

    await reader.cancel();

    expect(closed).toBe(1);
  });

  it("closes persistence when runtime disposal fails", async () => {
    let closed = 0;
    const repositories = Layer.mergeAll(
      stubRepositories(),
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.die("runtime dispose failed"))
      )
    );
    const worker = wfWorker({
      request: () => ({
        auth: trustWfGraphUpstream(),
        persistence: stubPersistence(repositories, async () => {
          closed += 1;
        }),
        encryption: ENCRYPTION,
      }),
    });

    await expect(
      worker.fetch(new Request("https://example.test/api/extensions"), {})
    ).rejects.toThrow("runtime dispose failed");
    expect(closed).toBe(1);
  });
});

describe("wfWorker runs workflows", () => {
  const appointmentCreated = defineEvent({
    name: "app/appointment.created",
    schema: Schema.Struct({ appointmentId: Schema.String }),
    correlationPath: "appointmentId",
  });
  const sendAction = defineAction({
    id: "test/send",
    label: "Send",
    description: "Runs one durable step",
    input: Schema.Struct({}),
    handler: async ({ step }) => {
      await step.run("dispatch", () => Promise.resolve(null));
      return {};
    },
  });
  const extensions = { events: [appointmentCreated], actions: [sendAction] };

  let dir: string;
  let filename: string;
  /** A connection of the case's own, which publishes and reads runs back. */
  let seed: ManagedRuntime.ManagedRuntime<WfGraphRepositories, never>;
  let seedClose: () => Promise<void>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wfgraph-worker-runs-"));
    filename = join(dir, "wfgraph.sqlite");
    const instance = await wfSqlite({ filename }).open(
      createIntegrationCipher(ENCRYPTION)
    );
    const runtime = ManagedRuntime.make(instance.repositories);
    await runtime.runPromise(
      publishWorkflow({
        workflowId: "wf_worker",
        versionId: "ver_worker",
        graph: createSerializedWorkflowGraph({
          nodes: [
            lifecycleNode({
              lifecycleRules: {
                concurrency: "unlimited",
                startEvents: [appointmentCreated.name],
                cancelEvents: [],
                allowManualStart: true,
              },
            }),
            actionNode("send", "test/send"),
          ],
          edges: [edge("entry", "send", "started")],
        }),
        catalogFingerprint: catalogFingerprint(
          assembleExtensions(extensions).catalog
        ),
        subscribe: true,
      })
    );
    seed = runtime;
    seedClose = async () => {
      await runtime.dispose();
      await instance.close();
    };
  });

  afterEach(async () => {
    await seedClose();
    await rm(dir, { recursive: true, force: true });
  });

  const statusOf = async (deliveryId: string) =>
    (
      await seed.runPromise(
        Effect.flatMap(ExecutionRepo, (executions) =>
          executions.findByDelivery({ workflowId: "wf_worker", deliveryId })
        )
      )
    )?.status;

  const postEvent = async (
    worker: WfGraphWorker<Record<string, never>>,
    appointmentId: string
  ): Promise<string> => {
    const response = await worker.fetch(
      new Request("https://example.test/api/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${EVENTS_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: appointmentCreated.name,
          data: { appointmentId },
        }),
      }),
      {}
    );
    expect(response.status).toBe(202);
    return String(readJsonObject(await response.json())?.id);
  };

  /** Counts each open and close of the SQLite backend the Worker runs on. */
  function countedSqlite() {
    const sqlite = wfSqlite({ filename });
    const counts = { opened: 0, closed: 0 };
    const persistence: WfGraphPersistence = {
      open: async (cipher) => {
        counts.opened += 1;
        const instance = await sqlite.open(cipher);
        return {
          ...instance,
          close: async () => {
            counts.closed += 1;
            await instance.close();
          },
        };
      },
    };
    return { persistence, counts };
  }

  it("sends one Queue message for a posted Event, and its queue tick delivers the Event and runs the workflow", async () => {
    const queue = recordingQueue();
    const { persistence, counts } = countedSqlite();
    const worker = wfWorker<Record<string, never>>({
      extensions,
      request: () => ({
        auth: trustWfGraphUpstream(),
        persistence,
        encryption: ENCRYPTION,
        events: { key: EVENTS_KEY },
        wakeQueue: queue,
      }),
    });

    const deliveryId = await postEvent(worker, "appt_queue");

    // The send settles before `fetch` answers, so the message is on the
    // Queue once the response is.
    expect(queue.sent).toEqual([{ kind: "wfgraph.wake" }]);
    expect(await statusOf(deliveryId)).toBeUndefined();

    await worker.queue({ messages: queue.sent.splice(0) }, {});

    // The delivery's pass started the run, and the tick's next drain step
    // claimed it, so one tick ran the workflow to its end.
    expect(await statusOf(deliveryId)).toBe("completed");
    // The run the delivery started announced a wake of its own.
    expect(queue.sent).toEqual([{ kind: "wfgraph.wake" }]);
    expect(counts).toEqual({ opened: 2, closed: 2 });
  });

  it("runs the workflow on the Cron Trigger's tick when no Queue is configured", async () => {
    const { persistence, counts } = countedSqlite();
    const worker = wfWorker<Record<string, never>>({
      extensions,
      request: () => ({
        auth: trustWfGraphUpstream(),
        persistence,
        encryption: ENCRYPTION,
        events: { key: EVENTS_KEY },
      }),
    });

    const deliveryId = await postEvent(worker, "appt_cron");
    expect(await statusOf(deliveryId)).toBeUndefined();

    await worker.scheduled({ cron: "* * * * *" }, {});

    expect(await statusOf(deliveryId)).toBe("completed");
    expect(counts).toEqual({ opened: 2, closed: 2 });
  });

  it("fails a tick whose persistence cannot open, so the Queue retries the batch", async () => {
    const worker = wfWorker<Record<string, never>>({
      extensions,
      request: () => ({
        auth: trustWfGraphUpstream(),
        persistence: {
          open: () => Promise.reject(new Error("database unreachable")),
        },
        encryption: ENCRYPTION,
      }),
    });

    await expect(
      worker.queue({ messages: [{ kind: "wfgraph.wake" }] }, {})
    ).rejects.toThrow("database unreachable");
  });
});
