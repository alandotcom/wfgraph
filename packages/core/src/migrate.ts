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
import { configureDatabaseRuntime } from "#src/backend/lib/db/index";
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
 * so a second caller waits and then finds nothing to do. Safe to run in a process
 * that already built an app too, on the same terms as anything else that
 * configures the database: a config equal field for field is reused, and one
 * differing anywhere is refused rather than quietly opening a second connection
 * beside the app's.
 *
 * `runMigrations` gives the connection back on its way out, so a one-shot process
 * exits when this resolves.
 */
export async function migrateRovaDatabase(
  options: RovaMigrateOptions
): Promise<void> {
  configureDatabaseRuntime(normalizeDatabaseConfig(options));
  await runMigrations({ migrationsDir: options.migrationsDir });
}
