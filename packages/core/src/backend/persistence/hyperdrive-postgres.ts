import {
  normalizeDatabaseConfig,
  type DatabaseRuntimeConfig,
} from "#src/backend/lib/db/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { relations } from "#src/backend/lib/db/schema";
import type { DatabaseSurface } from "#src/backend/lib/db/index";
import { makePostgresRepositories } from "#src/backend/persistence/postgres-repositories";
import type { WfGraphPersistence } from "#src/backend/persistence/types";

/** The part of Cloudflare's Hyperdrive binding Workflow Graph consumes. */
export type HyperdriveBinding = {
  readonly connectionString: string;
};

export type HyperdrivePostgresPersistenceOptions = {
  /** Must match the origin role's default first schema. Defaults to `_workflows`. */
  schema?: string | undefined;
};

/** How long closing an invocation's client waits for its queries, in seconds. */
const CLOSE_TIMEOUT_SECONDS = 5;

/** Connection-local options safe under Hyperdrive's transaction pooler. */
export function hyperdrivePostgresClientOptions() {
  return {
    max: 1,
    connection: { application_name: "wfgraph-hyperdrive" },
  };
}

/**
 * Configure per-invocation PostgreSQL through a Cloudflare Hyperdrive binding.
 *
 * The Worker host opens this backend once per invocation and closes it when
 * the invocation ends: after a request's response, or after a Cron Trigger's
 * or a Queue message's tick. The schema check makes a misconfigured origin
 * role fail before an unqualified repository query can land in `public`.
 */
export function wfHyperdrive(
  binding: HyperdriveBinding,
  options: HyperdrivePostgresPersistenceOptions = {}
): WfGraphPersistence {
  const config = normalizeDatabaseConfig({
    url: binding.connectionString,
    schema: options.schema,
    maxConnections: 1,
  } satisfies DatabaseRuntimeConfig);

  return {
    open: async (cipher) => {
      const client = postgres(
        config.url ?? "",
        hyperdrivePostgresClientOptions()
      );
      const database: DatabaseSurface = {
        schema: config.schema,
        client,
        db: drizzle({ client, relations }),
        // Bounded, so a query Hyperdrive never answers cannot hold the
        // invocation open: the timeout rejects it and destroys the connection.
        close: () => client.end({ timeout: CLOSE_TIMEOUT_SECONDS }),
      };
      try {
        const [row] = await database.client<
          Array<{ currentSchema: string | null }>
        >`select current_schema() as "currentSchema"`;
        if (row?.currentSchema !== config.schema) {
          throw new Error(
            `Hyperdrive's PostgreSQL origin resolved current_schema() to ${row?.currentSchema ?? "null"}, but Workflow Graph requires ${config.schema}. Set that schema first in the origin role's default search_path.`
          );
        }

        return {
          repositories: makePostgresRepositories(database, cipher),
          // Hyperdrive pools one connection per invocation, which cannot hold
          // a `LISTEN` open, and a tick runs one run's pass at a time on it,
          // beside one delivery's.
          capabilities: {
            connectionLimit: 1,
            processes: "many",
            loopDefaults: { concurrency: 1 },
          },
          description: {
            backend: "postgres-hyperdrive",
            schema: database.schema,
            host: client.options.host.join(","),
            port: client.options.port.join(","),
            database: client.options.database,
            user: client.options.user,
          },
          close: database.close,
        };
      } catch (error) {
        await database.close();
        throw error;
      }
    },
  };
}
