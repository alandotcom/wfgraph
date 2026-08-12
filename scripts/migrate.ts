// First, so the variables below are in place before anything reads them.
import "../load-env";
import { migrateWfGraphDatabase } from "@wfgraph/core/migrate";
import { configureWfGraphLogging } from "@wfgraph/core/logging";

// The migrator says what it is doing through LogTape, and Workflow Graph
// installs no configuration of its own, so a caller that wants to read those
// lines asks for them. An adopter's CI job writes this same line.
configureWfGraphLogging();

// `pnpm run db:migrate` against the dev database, and the same command by hand
// against a deployed one. It goes through the published entry rather than
// reaching into the migrator, so the path this repo exercises daily is the one an
// adopter's CI job takes.
//
// Reading the environment is this file's job rather than the library's, which is
// why the dev default sits here beside the variables: an adopter names their
// database in whatever their platform hands them.
const DEV_DATABASE_URL =
  "postgresql://workflow:workflow@localhost:55437/workflow_builder";

await migrateWfGraphDatabase({
  url: process.env.DATABASE_URL?.trim() || DEV_DATABASE_URL,
  schema: process.env.DATABASE_SCHEMA?.trim() || undefined,
  migrationsDir: process.env.MIGRATIONS_DIR?.trim(),
});
