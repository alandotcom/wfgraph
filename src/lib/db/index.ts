import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  apiKeys,
  integrations,
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutions,
  workflowExecutionsRelations,
  workflows,
  workflowWaitStates,
} from "./schema";

// Construct schema object for drizzle
const schema = {
  workflows,
  workflowExecutions,
  workflowExecutionLogs,
  workflowExecutionEvents,
  workflowExecutionsRelations,
  workflowWaitStates,
  apiKeys,
  integrations,
};

const connectionString =
  Bun.env.DATABASE_URL ||
  "postgresql://workflow:workflow@localhost:55437/workflow_builder";

// For migrations
export const migrationClient = postgres(connectionString, { max: 1 });

// Use global singleton to prevent connection exhaustion during HMR
const globalForDb = globalThis as unknown as {
  queryClient: ReturnType<typeof postgres> | undefined;
  db: PostgresJsDatabase<typeof schema> | undefined;
};

// For queries - reuse connection in development
const queryClient =
  globalForDb.queryClient ?? postgres(connectionString, { max: 10 });
export const db = globalForDb.db ?? drizzle(queryClient, { schema });

if (Bun.env.NODE_ENV !== "production") {
  globalForDb.queryClient = queryClient;
  globalForDb.db = db;
}
