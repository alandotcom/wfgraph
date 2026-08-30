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
import { migrateWfGraphDatabase } from "#src/migrate";
import { wfPostgres } from "#src/backend/persistence/postgres";
import {
  conformanceCipher,
  connect,
  type ConformanceDatabase,
} from "#src/backend/persistence/persistence-conformance-test-support";

/** Names the server. Unset means every case here skips. */
export const POSTGRES_TEST_URL_VARIABLE = "WFGRAPH_TEST_DATABASE_URL";

/**
 * Set where a database is known to be there, which is the CI job that starts
 * one. Skipping is how this suite stays out of a developer's way, and it is
 * also how the whole of it could report green having run nothing: a service
 * that failed to come up, a renamed variable or a drifted port would all look
 * identical to a machine with no Docker. Where this is set, an absent URL is an
 * error rather than a skip, so that failure has somewhere to surface.
 */
export const POSTGRES_REQUIRED_VARIABLE = "WFGRAPH_REQUIRE_POSTGRES";

/**
 * Reserved. The sweep drops anything carrying it, so nothing else may be named
 * this way in a database the suite is pointed at.
 */
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
    open: async (options) =>
      connect(
        await wfPostgres({
          url,
          schema,
          // Small, because a case may open several against one schema, and
          // vitest.config.ts holds this project to one file at a time for the
          // same reason: the server's default max_connections is 100.
          maxConnections: 5,
        }).open(options?.cipher ?? conformanceCipher)
      ),
    drop: () =>
      withAdminClient(async (client) => {
        await client.unsafe(`drop schema if exists "${schema}" cascade`);
      }),
  };
}
