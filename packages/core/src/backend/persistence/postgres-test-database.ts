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
 * Migrating costs about 50ms and dropping another 15; truncating every table
 * costs 13. Nothing outside `postgres-migrations.pg.test.ts` is about migrating,
 * so paying that per case bought only a slower suite. The schema is still one
 * case's worth of isolation, because a case never sees a row another left.
 *
 * The returned `teardown` drops the schema, and the registry calls it once the
 * last case is done.
 */
export function sharedPostgresTestDatabase(): {
  createDatabase: () => Promise<ConformanceDatabase>;
  teardown: () => Promise<void>;
} {
  // Nothing is reached for until a case asks, because a skipped `describe` still
  // evaluates its body: naming the server here would fail collection on a
  // machine that has none, which is the case this suite skips for.
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
    // Nothing to drop where no case ever asked for a database.
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
