/**
 * Where the live PostgreSQL suite gets a database, and what it does without one.
 *
 * Isolation is a schema per case: the tables are declared unqualified and the
 * connection's search_path decides where they land (ADR-0005), so a schema is
 * the whole of one Workflow Graph and dropping it removes the journal with it.
 * Every schema this mints carries TEST_SCHEMA_PREFIX, which is reserved.
 */

import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { describe } from "vitest";
import { ManagedRuntime } from "effect";
import { migrateWfGraphDatabase } from "#src/migrate";
import { wfPostgres } from "#src/backend/persistence/postgres";
import {
  conformanceCipher,
  type ConformanceDatabase,
} from "#src/backend/persistence/persistence-conformance-test-support";

/** Names the server. Unset means every case here skips. */
export const POSTGRES_TEST_URL_VARIABLE = "WFGRAPH_TEST_DATABASE_URL";

/**
 * Reserved. The sweep drops anything carrying it, so nothing else may be named
 * this way in a database the suite is pointed at.
 */
export const TEST_SCHEMA_PREFIX = "wfgraph_test_";

export function postgresTestUrl(): string | undefined {
  return process.env[POSTGRES_TEST_URL_VARIABLE]?.trim() || undefined;
}

/**
 * Runs a suite of its own when a server was named, and says why in the skipped
 * title when one was not. The conformance run does not use this; it carries the
 * same sentence on its harness, which keeps it from nesting one describe in
 * another that says the same thing.
 */
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

/**
 * The URL, or a sentence naming the variable. Called inside a case rather than
 * at module scope, because a skipped suite still evaluates its own body.
 */
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

/** A short-lived client for the setup and teardown the repositories cannot do. */
export async function withAdminClient<A>(
  query: (client: postgres.Sql) => Promise<A>
): Promise<A> {
  const client = postgres(requirePostgresTestUrl(), { max: 1 });

  try {
    return await query(client);
  } finally {
    await client.end();
  }
}

/**
 * One migrated schema, opened as often as a case asks.
 *
 * Migrations run once per database rather than per connection, so a second
 * connection for a race does not queue behind the advisory lock the migrator
 * holds.
 */
export async function createPostgresTestDatabase(): Promise<ConformanceDatabase> {
  const url = requirePostgresTestUrl();
  const schema = mintTestSchemaName();
  await migrateWfGraphDatabase({ url, schema });

  return {
    open: async () => {
      const instance = await wfPostgres({
        url,
        schema,
        maxConnections: 5,
      }).open(conformanceCipher);
      const runtime = ManagedRuntime.make(instance.repositories);
      return {
        run: runtime.runPromise.bind(runtime),
        close: async () => {
          await runtime.dispose();
          await instance.close();
        },
      };
    },
    drop: () =>
      withAdminClient(async (client) => {
        await client.unsafe(`drop schema if exists "${schema}" cascade`);
      }),
  };
}
