import {
  type DatabaseRuntimeConfig,
  normalizeDatabaseConfig,
} from "#src/backend/lib/db/config";
import {
  createDatabaseSurface,
  describeConnection,
} from "#src/backend/lib/db/index";
import {
  type MigrationsOptions,
  runMigrations,
} from "#src/backend/lib/db/migrations";
import type { WfGraphPersistence } from "#src/backend/persistence/types";
import { makePostgresRepositories } from "#src/backend/persistence/postgres-repositories";
import { createPostgresRunWakes } from "#src/backend/persistence/postgres-run-wakes";

/** How long a loop on PostgreSQL sleeps between claims when nothing wakes it. */
const POSTGRES_POLL_MS = 1_000;

/**
 * How many passes a loop on PostgreSQL runs at once. A pass spends most of its
 * time waiting on the database, so several overlap on one event loop.
 */
const POSTGRES_WORKER_CONCURRENCY = 10;

export type PostgresPersistenceOptions = DatabaseRuntimeConfig & {
  migrations?: MigrationsOptions | undefined;
};

/** Configure PostgreSQL as Workflow Graph's persistence backend. */
export function wfPostgres(
  options: PostgresPersistenceOptions
): WfGraphPersistence {
  const config = normalizeDatabaseConfig(options);

  return {
    open: async (cipher) => {
      const database = createDatabaseSurface(config);

      try {
        if (options.migrations?.runOnStartup === true) {
          await runMigrations(config, {
            migrationsDir: options.migrations.migrationsDir,
          });
        }

        const broadcast = createPostgresRunWakes({
          client: database.client,
          schema: database.schema,
        });
        return {
          repositories: makePostgresRepositories(database, cipher),
          capabilities: {
            broadcast,
            connectionLimit: config.maxConnections,
            processes: "many",
            loopDefaults: {
              pollMs: POSTGRES_POLL_MS,
              concurrency: POSTGRES_WORKER_CONCURRENCY,
            },
          },
          description: {
            backend: "postgres",
            ...describeConnection(database.client, database.schema),
          },
          close: async () => {
            await broadcast.close();
            await database.close();
          },
        };
      } catch (error) {
        await database.close();
        throw error;
      }
    },
  };
}
