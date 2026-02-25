import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getMigrationClient } from "@/backend/lib/db/index";
import { getAppLogger } from "@/backend/lib/logger";

const logger = getAppLogger("migrations");

const currentDir = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS_DIR_CANDIDATES = [
  resolve(process.cwd(), "drizzle"),
  resolve(currentDir, "../../../../drizzle"), // src/backend/lib/db/ → packages/core/drizzle/
  resolve(currentDir, "../../drizzle"), // dist/shared/ → packages/core/drizzle/ (bundled layout)
  resolve(currentDir, "../drizzle"), // dist/ → dist/drizzle/ (copied migrations)
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
