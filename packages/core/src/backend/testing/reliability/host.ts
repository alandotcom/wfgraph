import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import postgres from "postgres";
import {
  createWfGraphApp,
  trustWfGraphUpstream,
  type WfGraphRunnerOptions,
} from "#src/app";
import { createRequestListener } from "#src/node";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import { wfPostgres } from "#src/backend/persistence/postgres";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { WfGraphPersistence } from "#src/backend/persistence/types";
import { uniq } from "es-toolkit/array";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { fixtureExtensions } from "#src/backend/testing/reliability/fixtures";
import { boundary, eventually } from "#src/backend/testing/reliability/control";
import {
  InngestStartupFailure,
  startInngest,
} from "#src/backend/testing/reliability/inngest";

export class HostSetupFailure extends Error {
  constructor(
    cause: unknown,
    readonly evidence: { applicationLogs: unknown[][]; runtimeLogs: string[] }
  ) {
    super(`Reliability host setup failed: ${String(cause)}`, { cause });
  }
}

export type Backend = "sqlite" | "postgres";
export type ReliabilityHost = ReturnType<typeof fixtureExtensions> & {
  /**
   * One-shot repository faults a scenario arms. `admission` fires after
   * `startForEntity` commits a Start's run, so the delivery loses the answer
   * and the executor retries it. `completion` fires before a `completed` terminal
   * write and `terminal` before any other, whether a pass makes it fenced or
   * after it ended the run. `claim` fires after an Event delivery's claim
   * of a parked Wait commits, which resolves the park and re-queues the run in
   * the same write, so the delivery retries a claim that already landed.
   */
  faults: Record<
    "admission" | "completion" | "terminal" | "claim",
    ReturnType<typeof boundary>
  >;
  repo: ExecutionRepo["Service"];
  runtime: Awaited<ReturnType<typeof startInngest>>;
  /**
   * Sends an Event through `app.events.send`, answering its inbox row's id.
   * `id` is the idempotency key, so a repeat answers the first row's id.
   */
  send: (name: string, data: JsonObject, id?: string) => Promise<string>;
  /**
   * Sends an Event to the Inngest dev server, whose run of the app's forwarder
   * records it in the event inbox keyed by `id`.
   */
  sendThroughInngest: (
    name: string,
    data: JsonObject,
    id?: string
  ) => Promise<void>;
  /**
   * Waits until every forwarder run Inngest started has completed, and
   * answers the inbox row ids of every Event this host sent, each once.
   */
  inboxIds: () => Promise<string[]>;
  logs: unknown[][];
  /** The application's own `dispose`, which `close` also runs. */
  dispose: () => Promise<void>;
  close: () => Promise<void>;
  directory: string;
  rpc: (method: string, input: JsonObject) => Promise<unknown>;
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  snapshot: () => Promise<unknown>;
  publish: (graph: JsonObject) => Promise<string>;
};
/** How a family sets up its host beyond the backend. */
export type HostOptions = {
  /** The app's worker loop settings, over the backend's defaults. */
  runner?: WfGraphRunnerOptions | undefined;
};

export async function createHost(
  backend: Backend,
  options: HostOptions = {}
): Promise<ReliabilityHost> {
  const logs: unknown[][] = [];
  let runtimeLogs: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), "wfgraph-reliability-"));
  const faults = {
    admission: boundary(),
    completion: boundary(),
    terminal: boundary(),
    claim: boundary(),
  };
  const cleanup: Array<() => Promise<void>> = [
    () => rm(directory, { recursive: true, force: true }),
  ];
  const close = async () => {
    for (const fault of Object.values(faults)) fault.release();
    const failures: unknown[] = [];
    for (const dispose of cleanup.toReversed()) {
      try {
        // Resources must close in reverse dependency order.
        // eslint-disable-next-line no-await-in-loop
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Harness cleanup failed");
  };
  try {
    const fixture = fixtureExtensions();
    const base = createPersistence(backend, directory, cleanup);
    const repositories = Promise.withResolvers<ExecutionRepo["Service"]>();
    const persistence = injectRepositoryFaults(
      base,
      faults,
      repositories.resolve
    );
    const runtime = await startInngest(directory);
    cleanup.push(runtime.close);
    runtimeLogs = runtime.logs;
    const log = (...values: unknown[]) => {
      logs.push(values);
    };
    const app = await createWfGraphApp({
      auth: trustWfGraphUpstream(),
      persistence,
      encryption: { key: "c".repeat(64) },
      inngest: { id: "reliability", isDev: true, baseUrl: runtime.url },
      extensions: fixture.extensions,
      logger: { info: log, warn: log, error: log, debug: log },
      runner: options.runner,
    });
    cleanup.push(app.dispose);
    const server = createServer(createRequestListener(app));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing host port");
    const url = `http://127.0.0.1:${address.port}`;
    await runtime.register(`${url}/api/inngest`);
    // Stop deliveries before closing HTTP. The earlier registration also covers setup failure.
    cleanup.push(runtime.close);
    const repo = await repositories.promise;
    const rpc = async (method: string, input: JsonObject) => {
      const response = await fetch(`${url}/api/rpc/workflow/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
        signal: AbortSignal.timeout(10_000),
      });
      const body: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          `RPC ${method}: ${response.status} ${JSON.stringify(body)}`
        );
      return body;
    };
    const workflowIds: string[] = [];
    const sentInboxIds: string[] = [];
    const inngestSends: Array<{ name: string; data: JsonObject; id: string }> =
      [];
    return {
      dispose: app.dispose,
      ...fixture,
      faults,
      repo,
      runtime,
      async send(name: string, data: JsonObject, id?: string) {
        const sent = await app.events.send(omitUndefined({ name, data, id }));
        sentInboxIds.push(sent.id);
        return sent.id;
      },
      async sendThroughInngest(
        name: string,
        data: JsonObject,
        id: string = crypto.randomUUID()
      ) {
        await runtime.send(name, data, id);
        inngestSends.push({ name, data, id });
      },
      async inboxIds() {
        if (inngestSends.length === 0) return uniq(sentInboxIds);
        const runs = await eventually(
          "Inngest forwarder runs finished",
          () => runtime.allRuns(),
          (rows) =>
            rows.length > 0 &&
            rows.every((row) => !["RUNNING", "QUEUED"].includes(row.status))
        );
        const failed = runs.filter((row) => row.status !== "COMPLETED");
        if (failed.length > 0)
          throw new Error(
            `Inngest forwarder runs did not complete: ${JSON.stringify(failed)}`
          );
        // Every forwarder run completed, so each Inngest send holds its inbox
        // row by its event id. The same send through `app.events.send` is
        // answered with that row as a duplicate, which is how its id is read.
        const forwarded = await Promise.all(
          inngestSends.map(async (sent) => {
            const answer = await app.events.send(sent);
            if (!answer.duplicate)
              throw new Error(
                `No forwarder recorded the Inngest event ${sent.id} for ${sent.name}`
              );
            return answer.id;
          })
        );
        return uniq([...sentInboxIds, ...forwarded]);
      },
      logs,
      close,
      directory,
      rpc,
      run: <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect),
      snapshot: () => snapshotWorkflows(repo, workflowIds),
      async publish(graph: JsonObject) {
        const created = Schema.decodeUnknownSync(
          Schema.Struct({
            json: Schema.Struct({
              id: Schema.String,
              draftRevision: Schema.Number,
            }),
          })
        )(await rpc("create", { name: "Reliability scenario", graph }));
        const workflowId = created.json.id;
        workflowIds.push(workflowId);
        await rpc("publish", {
          workflowId,
          graph,
          expectedDraftRevision: created.json.draftRevision,
          expectedPublishedVersionId: null,
        });
        return workflowId;
      },
    };
  } catch (error) {
    if (error instanceof InngestStartupFailure) runtimeLogs = error.logs;
    try {
      await close();
    } catch (cleanupError) {
      throw new HostSetupFailure(
        new AggregateError(
          [error, cleanupError],
          `Setup: ${String(error)}; cleanup: ${String(cleanupError)}`,
          { cause: cleanupError }
        ),
        { applicationLogs: logs, runtimeLogs }
      );
    }
    throw new HostSetupFailure(error, { applicationLogs: logs, runtimeLogs });
  }
}

function createPersistence(
  backend: Backend,
  directory: string,
  cleanup: Array<() => Promise<void>>
): WfGraphPersistence {
  if (backend === "sqlite")
    return wfSqlite({ filename: join(directory, "workflow.sqlite") });
  const url = process.env.WFGRAPH_TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      "WFGRAPH_TEST_DATABASE_URL is required for reliability PostgreSQL tests"
    );
  const schema = `wfgraph_test_reliability_${crypto.randomUUID().replaceAll("-", "")}`;
  cleanup.push(async () => {
    const client = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await client.unsafe(`drop schema if exists "${schema}" cascade`);
    } finally {
      await client.end();
    }
  });
  return wfPostgres({
    url,
    schema,
    maxConnections: 5,
    migrations: { runOnStartup: true },
  });
}

function injectRepositoryFaults(
  base: WfGraphPersistence,
  faults: ReliabilityHost["faults"],
  onRepositoryOpen: (repo: ExecutionRepo["Service"]) => void
): WfGraphPersistence {
  // A pass writes the terminal record through its fenced writes while it holds
  // the lease, and through the unfenced method once it has ended the run, so
  // both carry the same one-shot fault.
  const finishRun = <A, E>(
    input: { status: string },
    write: Effect.Effect<A, E>
  ) =>
    input.status === "completed"
      ? faults.completion.apply(write, "before")
      : faults.terminal.apply(write, "before");
  return {
    open: async (cipher) => {
      const instance = await base.open(cipher);
      const reader = ManagedRuntime.make(instance.repositories);
      const repo = await reader.runPromise(ExecutionRepo);
      onRepositoryOpen(repo);
      const wrapped: ExecutionRepo["Service"] = {
        ...repo,
        startForEntity: (input) =>
          faults.admission.apply(repo.startForEntity(input), "after"),
        finishRun: (input) => finishRun(input, repo.finishRun(input)),
        fenced: (fence) => {
          const writes = repo.fenced(fence);
          return {
            ...writes,
            finishRun: (input) => finishRun(input, writes.finishRun(input)),
          };
        },
        claimWaitingStateById: (input) =>
          faults.claim.apply(repo.claimWaitingStateById(input), "after"),
      };
      return {
        ...instance,
        repositories: Layer.merge(
          instance.repositories,
          Layer.succeed(ExecutionRepo, wrapped)
        ),
        close: async () => {
          await reader.dispose();
          await instance.close();
        },
      };
    },
  };
}

async function snapshotWorkflows(
  repo: ExecutionRepo["Service"],
  workflowIds: string[]
) {
  return Promise.all(
    workflowIds.map(async (workflowId) => {
      const runs = await Effect.runPromise(
        repo.listByWorkflow({ workflowId, includeSuperseded: true })
      );
      return {
        workflowId,
        executions: await Promise.all(
          runs.map(async (row) => ({
            ...row,
            summary: await Effect.runPromise(repo.findSummaryById(row.id)),
            waits: await Effect.runPromise(repo.listWaitingStates(row.id)),
            schedule: await Effect.runPromise(
              repo.findSchedule({ executionId: row.id })
            ),
            stepMemo: await Effect.runPromise(
              repo.listStepMemo({ executionId: row.id })
            ),
            logs: await Effect.runPromise(repo.listLogs(row.id)),
            events: await Effect.runPromise(repo.listEvents(row.id)),
          }))
        ),
      };
    })
  );
}
