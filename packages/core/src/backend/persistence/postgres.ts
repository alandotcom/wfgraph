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

export type PostgresPersistenceOptions = DatabaseRuntimeConfig & {
  migrations?: MigrationsOptions;
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

        return {
          repositories: makePostgresRepositories(database, cipher),
          description: {
            backend: "postgres",
            ...describeConnection(database.client, database.schema),
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
