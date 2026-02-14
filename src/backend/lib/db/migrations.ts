import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { migrationClient } from "@/backend/lib/db/index";
import { getAppLogger } from "@/backend/lib/logger";

const logger = getAppLogger("migrations");

const DEFAULT_MIGRATIONS_DIR = resolve(process.cwd(), "drizzle");

function getMigrationsFolder(): string {
  const configuredFolder = Bun.env.MIGRATIONS_DIR?.trim();
  if (!configuredFolder) {
    return DEFAULT_MIGRATIONS_DIR;
  }

  return resolve(process.cwd(), configuredFolder);
}

function shouldRunMigrations(): boolean {
  return Bun.env.RUN_DB_MIGRATIONS === "true";
}

export async function runMigrationsIfRequested(): Promise<void> {
  if (!shouldRunMigrations()) {
    logger.info(
      "Skipping migrations (set RUN_DB_MIGRATIONS=true to run them at startup)"
    );
    return;
  }

  const migrationsFolder = getMigrationsFolder();

  const migrationPath = Bun.file(migrationsFolder);
  let isDirectory = false;

  try {
    const stats = await migrationPath.stat();
    isDirectory = stats.isDirectory();
  } catch {
    isDirectory = false;
  }

  if (!isDirectory) {
    throw new Error(
      `Migrations folder not found or invalid at ${migrationsFolder}. Set MIGRATIONS_DIR to a valid folder path.`
    );
  }

  logger.info("Running database migrations", { migrationsFolder });

  const migrationDb = drizzle(migrationClient);
  await migrate(migrationDb, {
    migrationsFolder,
  });

  logger.info("Database migrations completed");
}
