// First, so RUN_DB_MIGRATIONS and DATABASE_URL are in place before the module
// below is evaluated and reads them.
import "../load-env";
import { runMigrationsIfRequested } from "@/backend/lib/db/migrations";

await runMigrationsIfRequested();
