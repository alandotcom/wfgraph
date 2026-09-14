import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import postgres from "postgres";
import { createWfGraphApp, trustWfGraphUpstream } from "#src/app";
import { createRequestListener } from "#src/node";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import { wfPostgres } from "#src/backend/persistence/postgres";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { WfGraphPersistence } from "#src/backend/persistence/types";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { fixtureExtensions } from "#src/backend/testing/reliability/fixtures";
import { boundary } from "#src/backend/testing/reliability/control";
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
  faults: Record<
    "admission" | "completion" | "terminal" | "settlement",
    ReturnType<typeof boundary>
  >;
  repo: ExecutionRepo["Service"];
  runtime: Awaited<ReturnType<typeof startInngest>>;
  logs: unknown[][];
  close: () => Promise<void>;
  directory: string;
  rpc: (method: string, input: JsonObject) => Promise<unknown>;
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  snapshot: () => Promise<unknown>;
  publish: (graph: JsonObject) => Promise<string>;
};
export async function createHost(backend: Backend): Promise<ReliabilityHost> {
  const logs: unknown[][] = [];
  let runtimeLogs: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), "wfgraph-reliability-"));
  const faults = {
    admission: boundary(),
    completion: boundary(),
    terminal: boundary(),
    settlement: boundary(),
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
    return {
      ...fixture,
      faults,
      repo,
      runtime,
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
  else {
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
}

function injectRepositoryFaults(
  base: WfGraphPersistence,
  faults: ReliabilityHost["faults"],
  onRepositoryOpen: (repo: ExecutionRepo["Service"]) => void
): WfGraphPersistence {
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
        finishRun: (input) =>
          input.status === "completed"
            ? faults.completion.apply(repo.finishRun(input), "before")
            : faults.terminal.apply(repo.finishRun(input), "before"),
        settleWaitingStateClaim: (input) =>
          faults.settlement.apply(
            repo.settleWaitingStateClaim(input),
            "before"
          ),
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
            waits: await Effect.runPromise(repo.listActiveWaitStates(row.id)),
            logs: await Effect.runPromise(repo.listLogs(row.id)),
            events: await Effect.runPromise(repo.listEvents(row.id)),
          }))
        ),
      };
    })
  );
}
