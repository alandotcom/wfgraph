import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import {
  defineWfGraphAuth,
  trustWfGraphUpstream,
  WfGraphAccess,
  wfWorker,
  type WfGraphWorker,
} from "#src/worker";
import type { WfGraphPersistence } from "#src/backend/persistence/types";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import {
  stubApiKeyRepo,
  stubExecutionRepo,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("wfWorker", () => {
  it("supports one environment type while auth closes over arbitrary session state", () => {
    type WorkerEnv = { INTEGRATION_ENCRYPTION_KEY: string };
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
    const request = (env: WorkerEnv) => ({
      auth,
      persistence,
      encryption: { key: env.INTEGRATION_ENCRYPTION_KEY },
      inngest: { id: "wfgraph-worker-test", isDev: true },
    });

    const inferredWorker = wfWorker({ request });
    const explicitEnvironmentWorker = wfWorker<WorkerEnv>({
      request,
    });

    expectTypeOf(inferredWorker).toEqualTypeOf<WfGraphWorker<WorkerEnv>>();
    expectTypeOf(explicitEnvironmentWorker).toEqualTypeOf<
      WfGraphWorker<WorkerEnv>
    >();
    expect(WfGraphAccess.all.allows).toBeTypeOf("function");
  });

  it("resolves request-scoped extensions from the Worker environment", async () => {
    const repositories = Layer.mergeAll(
      stubApiKeyRepo(),
      stubExecutionRepo(),
      stubIntegrationRepo(),
      stubWorkflowRepo()
    );
    const persistence: WfGraphPersistence = {
      open: async () => ({
        repositories,
        description: { backend: "test" },
        close: () => Promise.resolve(),
      }),
    };
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
        persistence,
        encryption: { key: "d".repeat(64) },
        inngest: { id: "wfgraph-worker-test", isDev: true },
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
    const sqlite = wfSqlite({
      filename: join(directory, "wfgraph.db"),
    });
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
        encryption: { key: "d".repeat(64) },
        inngest: { id: "wfgraph-worker-test", isDev: true },
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

  it("closes persistence when runtime disposal fails", async () => {
    let closed = 0;
    const repositories = Layer.mergeAll(
      stubApiKeyRepo(),
      stubExecutionRepo(),
      stubIntegrationRepo(),
      stubWorkflowRepo(),
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.die("runtime dispose failed"))
      )
    );
    const persistence: WfGraphPersistence = {
      open: async () => ({
        repositories,
        description: { backend: "test" },
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      }),
    };
    const worker = wfWorker({
      request: () => ({
        auth: trustWfGraphUpstream(),
        persistence,
        encryption: { key: "d".repeat(64) },
        inngest: { id: "wfgraph-worker-test", isDev: true },
      }),
    });

    await expect(
      worker.fetch(new Request("https://example.test/api/extensions"), {})
    ).rejects.toThrow("runtime dispose failed");
    expect(closed).toBe(1);
  });
});
