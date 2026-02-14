import { runMigrationsIfRequested } from "@/backend/lib/db/migrations";

await runMigrationsIfRequested();
