// First, so DATABASE_URL and DATABASE_SCHEMA are in place before the module
// below is evaluated and reads them.
import "../load-env";
import { closeMigrationClient } from "@rova/core/backend/lib/db/index";
import { runMigrations } from "@rova/core/backend/lib/db/migrations";

// Rova's own migrator, both for `pnpm run db:migrate` against the dev database
// and by hand against a deployed one. drizzle-kit's migrate command cannot stand
// in for it: the generated SQL names no schema, and the search_path that decides
// which schema the tables go in rides on the connection Rova opens.
await runMigrations({ migrationsDir: process.env.MIGRATIONS_DIR?.trim() });
await closeMigrationClient();
