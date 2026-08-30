/**
 * What the shipped migrations do to a real PostgreSQL, which no other test can
 * ask: the generated SQL is only ever read as text elsewhere.
 */

import { expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Effect, ManagedRuntime } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  assertJournalHashesAreOurs,
  wfgraphMigrationsDir,
} from "#src/backend/lib/db/migrations";
import { tables } from "#src/backend/lib/db/schema";
import { migrateWfGraphDatabase } from "#src/migrate";
import { wfPostgres } from "#src/backend/persistence/postgres";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  conformanceCipher,
  type ConformanceConnection,
} from "#src/backend/persistence/persistence-conformance-test-support";
import {
  describePostgres,
  mintTestSchemaName,
  requirePostgresTestUrl,
  withAdminClient,
} from "#src/backend/persistence/postgres-test-database";

const MIGRATIONS_TABLE = "__drizzle_migrations";
const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });

/** Every schema a case mints, dropped however the case ended. */
const minted: string[] = [];

async function freshSchema(): Promise<string> {
  const schema = mintTestSchemaName();
  minted.push(schema);
  return schema;
}

async function dropMinted(): Promise<void> {
  await withAdminClient(async (client) => {
    for (const schema of minted.splice(0)) {
      await client.unsafe(`drop schema if exists "${schema}" cascade`);
    }
  });
}

describePostgres("PostgreSQL migrations", () => {
  const shippedHashes = () =>
    readMigrationFiles({ migrationsFolder: wfgraphMigrationsDir() }).map(
      (migration) => migration.hash
    );

  it("builds every table in the schema it was given and nothing in public", async () => {
    const schema = await freshSchema();
    try {
      await migrateWfGraphDatabase({ url: requirePostgresTestUrl(), schema });

      const state = await withAdminClient(async (client) => {
        const present = await client<{ table_name: string }[]>`
          select table_name from information_schema.tables
          where table_schema = ${schema}
        `;
        // The shipped SQL names no schema, so a lost search_path would have
        // built all of this in public instead. scripts/unqualify-migrations.ts
        // is what keeps the qualifier out, and this is the only place its work
        // is checked against a server rather than against the file it wrote.
        const [stray] = await client<{ leaked: string | null }[]>`
          select to_regclass('public.workflows')::text as leaked
        `;
        return {
          names: present.map((row) => row.table_name),
          leaked: stray?.leaked ?? null,
        };
      });

      for (const table of Object.values(tables)) {
        expect(state.names).toContain(getTableName(table));
      }
      expect(state.names).toContain(MIGRATIONS_TABLE);
      expect(state.leaked).toBeNull();
    } finally {
      await dropMinted();
    }
  });

  it("records the migrations this build ships, and reruns none of them", async () => {
    const schema = await freshSchema();
    try {
      const url = requirePostgresTestUrl();
      await migrateWfGraphDatabase({ url, schema });
      const afterFirst = await recordedHashes(schema);

      // Every replica that starts with migrations.runOnStartup applies them
      // again. Nothing here has ever proven the second pass is a no-op.
      const instance = await wfPostgres({
        url,
        schema,
        migrations: { runOnStartup: true },
      }).open(conformanceCipher);
      await instance.close();
      const afterSecond = await recordedHashes(schema);

      expect(afterFirst).toEqual(shippedHashes());
      expect(afterSecond).toEqual(afterFirst);
      expect(() =>
        assertJournalHashesAreOurs(afterSecond, {
          migrationsFolder: wfgraphMigrationsDir(),
          schema,
        })
      ).not.toThrow();
    } finally {
      await dropMinted();
    }
  });

  it("refuses a journal carrying a migration this build does not ship", async () => {
    const schema = await freshSchema();
    try {
      await migrateWfGraphDatabase({ url: requirePostgresTestUrl(), schema });
      const recorded = [...(await recordedHashes(schema)), "a-foreign-hash"];

      expect(() =>
        assertJournalHashesAreOurs(recorded, {
          migrationsFolder: wfgraphMigrationsDir(),
          schema,
        })
      ).toThrow(/does not ship/);
    } finally {
      await dropMinted();
    }
  });

  it("keeps two schemas in one database out of each other's way", async () => {
    const first = await freshSchema();
    const second = await freshSchema();
    const connections: ConformanceConnection[] = [];

    try {
      const url = requirePostgresTestUrl();
      await migrateWfGraphDatabase({ url, schema: first });
      await migrateWfGraphDatabase({ url, schema: second });

      const connect = async (schema: string) => {
        const instance = await wfPostgres({ url, schema }).open(
          conformanceCipher
        );
        const runtime = ManagedRuntime.make(instance.repositories);
        const connection = {
          run: runtime.runPromise.bind(runtime),
          close: async () => {
            await runtime.dispose();
            await instance.close();
          },
        };
        connections.push(connection);
        return connection;
      };

      const one = await connect(first);
      const other = await connect(second);

      await one.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
        })
      );

      const readOther = () =>
        other.run(
          Effect.gen(function* () {
            const workflows = yield* WorkflowRepo;
            return {
              byId: yield* workflows.findById("wf_1"),
              all: yield* workflows.listSummariesNewestFirst,
            };
          })
        );

      expect(await readOther()).toMatchObject({ byId: null, all: [] });

      // Dropping one schema is how Workflow Graph leaves a database. The other
      // one it shares the database with must not notice.
      await withAdminClient(async (client) => {
        await client.unsafe(`drop schema "${first}" cascade`);
      });

      expect(await readOther()).toMatchObject({ byId: null, all: [] });
    } finally {
      await Promise.all(connections.map((one) => one.close()));
      await dropMinted();
    }
  });
});

async function recordedHashes(schema: string): Promise<string[]> {
  return withAdminClient(async (client) => {
    const rows = await client<{ hash: string }[]>`
      select hash from ${client(schema)}.${client(MIGRATIONS_TABLE)}
      order by created_at
    `;
    return rows.map((row) => row.hash);
  });
}
