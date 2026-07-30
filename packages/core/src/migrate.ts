/**
 * Applying Rova's migrations without building an app, for a CI job or a release
 * step.
 *
 * This exists because the shipped SQL cannot be applied by anything else. It
 * names no schema, so which schema it builds is decided by the `search_path` the
 * connection carries, and Rova's migrator is what carries it; drizzle-kit's own
 * `migrate` has no way to send one. An adopter reaching for `psql` or another
 * migration tool would get the tables in `public`.
 */

import {
  type DatabaseRuntimeConfig,
  normalizeDatabaseConfig,
} from "#src/backend/lib/db/config";
import {
  type MigrationsOptions,
  runMigrations,
} from "#src/backend/lib/db/migrations";

export type { DatabaseRuntimeConfig } from "#src/backend/lib/db/config";

/**
 * Where the database is, and where the migrations are if not where Rova ships
 * them.
 *
 * Flat, so `migrationsDir` sits beside the connection fields rather than under a
 * `migrations` key. `RovaAppOptions.database` nests it, and handing that object
 * straight to this function would otherwise typecheck while dropping the
 * directory it names, so `migrations` is refused here by name.
 */
export type RovaMigrateOptions = DatabaseRuntimeConfig &
  Pick<MigrationsOptions, "migrationsDir"> & { migrations?: never };

/**
 * Migrates the database the options name, then gives the connection back.
 *
 * Safe to run from several places at once: the migrator holds an advisory lock,
 * so a second caller waits and then finds nothing to do. The connection is this
 * call's own and nothing else in the process shares it, so running this beside a
 * live app costs one short-lived connection and takes no claim on the database.
 *
 * `runMigrations` gives the connection back on its way out, so a one-shot process
 * exits when this resolves.
 */
export async function migrateRovaDatabase(
  options: RovaMigrateOptions
): Promise<void> {
  await runMigrations(normalizeDatabaseConfig(options), {
    migrationsDir: options.migrationsDir,
  });
}
