import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { getMigrationClient } from "@/backend/lib/db/index";
import { getAppLogger } from "@/backend/lib/logger";

const logger = getAppLogger("migrations");

const MIGRATIONS_DIR_CANDIDATES = [
  resolve(process.cwd(), "drizzle"),
  resolve(import.meta.dir, "../../../../drizzle"),
  resolve(import.meta.dir, "../../../drizzle"),
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

  for (const candidate of candidates) {
    const migrationPath = Bun.file(candidate);
    try {
      const stats = await migrationPath.stat();
      if (stats.isDirectory()) {
        return candidate;
      }
    } catch {
      // Keep scanning candidates.
    }
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
  });

  logger.info("Database migrations completed");
}

export async function runMigrationsIfRequested(): Promise<void> {
  await runMigrations({
    runOnStartup: Bun.env.RUN_DB_MIGRATIONS === "true",
    migrationsDir: Bun.env.MIGRATIONS_DIR?.trim(),
  });
}
