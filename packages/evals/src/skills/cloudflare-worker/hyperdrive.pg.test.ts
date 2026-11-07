/**
 * Task check for the wfgraph-core/cloudflare-worker skill, the Hyperdrive
 * part, against a live PostgreSQL standing in for Hyperdrive's origin. It
 * runs in the `postgres` Vitest project and skips without
 * `WFGRAPH_TEST_DATABASE_URL` (`docker compose up -d` serves one).
 *
 * `expectWorkerOpens` is the grader: the Worker opens Hyperdrive and serves a
 * request. It passes when the factory's `schema` is the origin role's first
 * schema, and rejects the documented entry against an origin role whose
 * default `search_path` was never set. A separate case checks that moving the
 * Worker's runs into a `createWfGraphRunner` process is refused.
 */

import { expect, it } from "vitest";
import { createWfGraphRunner } from "@wfgraph/core";
import {
  trustWfGraphUpstream,
  wfHyperdrive,
  wfWorker,
  type WfGraphWorker,
} from "@wfgraph/core/worker";
import {
  describePostgres,
  requirePostgresTestUrl,
  withAdminClient,
} from "@wfgraph/core/backend/persistence/postgres-test-database";
import { ENCRYPTION } from "#src/skills/host";
import documentedWorker, {
  type Env,
} from "#src/skills/cloudflare-worker/worker-entry";

/** The environment Wrangler would give the Worker, pointed at the test server. */
function testEnv(): Env {
  return {
    HYPERDRIVE: { connectionString: requirePostgresTestUrl() },
    WFGRAPH_WAKES: { send: () => Promise.resolve() },
    INTEGRATION_ENCRYPTION_KEY: ENCRYPTION.key,
    WFGRAPH_EVENTS_KEY: "events-key-for-the-skill-check",
  };
}

/** The schema the test role's default `search_path` resolves first. */
async function originFirstSchema(): Promise<string> {
  return await withAdminClient(async (client) => {
    const [row] = await client<
      Array<{ schema: string }>
    >`select current_schema() as "schema"`;
    if (row === undefined) throw new Error("current_schema() answered no row");
    return row.schema;
  });
}

/** The grader: one editor request through the Worker's `fetch` answers 200. */
async function expectWorkerOpens(worker: WfGraphWorker<Env>): Promise<void> {
  const closes: Promise<unknown>[] = [];
  const response = await worker.fetch(
    new Request("https://workflows.example.com/api/extensions", {
      headers: { cookie: "session=editor" },
    }),
    testEnv(),
    { waitUntil: (promise) => void closes.push(promise) }
  );
  await Promise.all(closes);
  expect(response.status).toBe(200);
}

describePostgres(
  "wfgraph-core/cloudflare-worker task check: Hyperdrive",
  () => {
    it("opens Hyperdrive when the factory's schema is the origin role's first schema", async () => {
      const schema = await originFirstSchema();
      const worker = wfWorker<Env>({
        request: (env) => ({
          auth: trustWfGraphUpstream(),
          persistence: wfHyperdrive(env.HYPERDRIVE, { schema }),
          encryption: { key: env.INTEGRATION_ENCRYPTION_KEY },
        }),
      });
      await expectWorkerOpens(worker);
    });

    // The documented entry expects `_workflows` first on the origin role's
    // search_path. Against a role nobody configured, every invocation refuses
    // before a query can land in another schema.
    it("rejects the Worker against an origin role whose search_path was never set", async () => {
      expect(await originFirstSchema()).not.toBe("_workflows");
      await expect(expectWorkerOpens(documentedWorker)).rejects.toThrow(
        "Set that schema first in the origin role's default search_path"
      );
    });

    // A Worker has no long-lived process, and a runner process beside it is
    // refused at startup rather than left polling a Hyperdrive connection.
    it("refuses createWfGraphRunner on Hyperdrive", async () => {
      const schema = await originFirstSchema();
      await expect(
        createWfGraphRunner({
          persistence: wfHyperdrive(
            { connectionString: requirePostgresTestUrl() },
            { schema }
          ),
          encryption: ENCRYPTION,
        })
      ).rejects.toThrow(
        "This persistence backend runs no long-lived worker loop"
      );
    });
  }
);
