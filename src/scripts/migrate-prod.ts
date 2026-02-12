import { execSync } from "node:child_process";

const shouldRunMigrations = Bun.env.RUN_DB_MIGRATIONS === "true";

if (shouldRunMigrations) {
  console.log("RUN_DB_MIGRATIONS=true, running database migrations...");
  try {
    execSync("bun run db:migrate", { stdio: "inherit" });
    console.log("Migrations completed successfully");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
} else {
  console.log(
    "Skipping migrations (set RUN_DB_MIGRATIONS=true to run them during build)"
  );
}
