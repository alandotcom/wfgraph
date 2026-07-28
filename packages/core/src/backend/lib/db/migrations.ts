import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getMigrationClient } from "#src/backend/lib/db/index";
import { getAppLogger } from "#src/backend/lib/logger";

const logger = getAppLogger("migrations");

const currentDir = dirname(fileURLToPath(import.meta.url));

// packages/core/drizzle is the one copy of the migrations. drizzle-kit generates
// into it, "files" in packages/core/package.json publishes it, and each entry
// below is that same directory seen from a layout the code can run in.
// Nothing here is resolved from the working directory: an embedder who runs
// drizzle-kit themselves has their own ./drizzle beside it, and picking that up
// would run their migrations on Rova's connection. An operator whose migrations
// really do sit beside the process says so with MIGRATIONS_DIR or
// migrations.migrationsDir.
const MIGRATIONS_DIR_CANDIDATES = [
  // Running from source, this file being packages/core/src/backend/lib/db/.
  resolve(currentDir, "../../../../drizzle"),
  // Installed as a package, this file being bundled into a chunk in the
  // package's dist/.
  resolve(currentDir, "../drizzle"),
];

export type MigrationsRuntimeOptions = {
  runOnStartup: boolean;
  migrationsDir?: string;
};

async function resolveExistingMigrationsDir(
  configuredPath: string | undefined
): Promise<string> {
  const candidates = configuredPath
    ? [resolve(process.cwd(), configuredPath)]
    : MIGRATIONS_DIR_CANDIDATES;

  const findExistingCandidate = async (
    index: number
  ): Promise<string | null> => {
    const candidate = candidates[index];
    if (!candidate) {
      return null;
    }

    try {
      const stats = await stat(candidate);
      if (stats.isDirectory()) {
        return candidate;
      }
    } catch {
      // Keep scanning candidates.
    }

    return findExistingCandidate(index + 1);
  };

  const existingCandidate = await findExistingCandidate(0);
  if (existingCandidate) {
    return existingCandidate;
  }

  throw new Error(
    `Migrations folder not found. Checked: ${candidates.join(", ")}.` +
      " If needed, pass migrations.migrationsDir in server.start(...)."
  );
}

export async function runMigrations(
  options: MigrationsRuntimeOptions
): Promise<void> {
  if (!options.runOnStartup) {
    logger.debug(
      "Skipping migrations (set runOnStartup=true to run them at startup)"
    );
    return;
  }

  const migrationsFolder = await resolveExistingMigrationsDir(
    options.migrationsDir?.trim()
  );

  logger.info("Running database migrations", { migrationsFolder });

  const migrationDb = drizzle(getMigrationClient());
  await migrate(migrationDb, {
    migrationsFolder,
    migrationsSchema: "_workflows_drizzle_migrations",
  });

  logger.info("Database migrations completed");
}

export async function runMigrationsIfRequested(): Promise<void> {
  await runMigrations({
    runOnStartup: process.env.RUN_DB_MIGRATIONS === "true",
    migrationsDir: process.env.MIGRATIONS_DIR?.trim(),
  });
}
