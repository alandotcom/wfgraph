/**
 * Where the live PostgreSQL suite gets a database, and what it does without one.
 *
 * Isolation is a schema, because the tables are unqualified and search_path
 * decides where they land (ADR-0005): one schema is the whole of one Workflow
 * Graph, journal included.
 */

import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { getTableName } from "drizzle-orm";
import { describe } from "vitest";
import { migrateWfGraphDatabase } from "#src/migrate";
import { wfPostgres } from "#src/backend/persistence/postgres";
import { tables } from "#src/backend/lib/db/schema";
import {
  conformanceCipher,
  connect,
  type ConformanceDatabase,
} from "#src/backend/persistence/persistence-conformance-test-support";

/** Names the server. Unset means every case here skips. */
export const POSTGRES_TEST_URL_VARIABLE = "WFGRAPH_TEST_DATABASE_URL";

/** Set where a database is known to be there, so a missing URL fails the run. */
export const POSTGRES_REQUIRED_VARIABLE = "WFGRAPH_REQUIRE_POSTGRES";

/** Reserved: the sweep drops every schema carrying it. */
export const TEST_SCHEMA_PREFIX = "wfgraph_test_";

export function postgresTestUrl(): string | undefined {
  const url = process.env[POSTGRES_TEST_URL_VARIABLE]?.trim() || undefined;

  if (!url && process.env[POSTGRES_REQUIRED_VARIABLE]?.trim()) {
    throw new Error(
      `${POSTGRES_REQUIRED_VARIABLE} is set, so this run is meant to have a database, but ${POSTGRES_TEST_URL_VARIABLE} names none. Skipping here would report a green suite that ran nothing.`
    );
  }

  return url;
}

/** A suite of its own, whose skipped title names what would run it. */
export function describePostgres(name: string, suite: () => void): void {
  if (postgresTestUrl()) {
    describe(name, suite);
    return;
  }

  describe.skip(
    `${name} (set ${POSTGRES_TEST_URL_VARIABLE} to run it: docker compose up -d)`,
    suite
  );
}

/** Call from inside a case: a skipped suite still evaluates its own body. */
export function requirePostgresTestUrl(): string {
  const url = postgresTestUrl();

  if (!url) {
    throw new Error(
      `Set ${POSTGRES_TEST_URL_VARIABLE} before running the live PostgreSQL suite. \`docker compose up -d\` serves one.`
    );
  }

  return url;
}

/** A schema name Postgres reads back as written: lowercase, well under 63 bytes. */
export function mintTestSchemaName(): string {
  return `${TEST_SCHEMA_PREFIX}${process.pid}_${randomBytes(6).toString("hex")}`;
}

export async function withAdminClient<A>(
  query: (client: postgres.Sql) => Promise<A>
): Promise<A> {
  const client = postgres(requirePostgresTestUrl(), {
    max: 1,
    // A `drop schema ... cascade` reports every object it took with it, and
    // postgres.js prints that with console.log unless it is given somewhere
    // else to put it. Nothing here reads them.
    onnotice: () => undefined,
  });

  try {
    return await query(client);
  } finally {
    await client.end();
  }
}

/**
 * One migrated schema for a whole file, emptied between cases.
 *
 * Migrating costs roughly four times what truncating does, and nothing outside
 * `postgres-migrations.pg.test.ts` is about migrating. A case still never sees
 * a row another left.
 */
export function sharedPostgresTestDatabase(): {
  createDatabase: () => Promise<ConformanceDatabase>;
  teardown: () => Promise<void>;
} {
  // Reached for only when a case asks, since a skipped `describe` still
  // evaluates its body.
  let ready:
    | {
        url: string;
        schema: string;
        qualified: string;
        migrated: Promise<void>;
      }
    | undefined;

  const start = () => {
    if (!ready) {
      const url = requirePostgresTestUrl();
      const schema = mintTestSchemaName();
      ready = {
        url,
        schema,
        qualified: Object.values(tables)
          .map((table) => `"${schema}"."${getTableName(table)}"`)
          .join(", "),
        migrated: migrateWfGraphDatabase({ url, schema }),
      };
    }
    return ready;
  };

  return {
    createDatabase: async () => {
      const { url, schema, qualified, migrated } = start();
      await migrated;

      return {
        open: async (options) =>
          connect(
            await wfPostgres({ url, schema, maxConnections: 5 }).open(
              options?.cipher ?? conformanceCipher
            )
          ),
        // One statement, so the foreign keys between these tables never decide
        // an order. RESTART IDENTITY because a case may read a sequence back.
        drop: () =>
          withAdminClient(async (client) => {
            await client.unsafe(
              `truncate ${qualified} restart identity cascade`
            );
          }),
      };
    },
    teardown: async () => {
      if (!ready) {
        return;
      }
      const { schema } = ready;
      await withAdminClient(async (client) => {
        await client.unsafe(`drop schema if exists "${schema}" cascade`);
      });
    },
  };
}
