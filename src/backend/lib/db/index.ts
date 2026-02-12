import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { drizzle } from "drizzle-orm/bun-sql";
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

const createSqlClient = (url: string, max: number) => new Bun.SQL(url, { max });

// For migrations
export const migrationClient = createSqlClient(connectionString, 1);

// Use global singleton to prevent connection exhaustion during HMR
const globalForDb = globalThis as unknown as {
  queryClient: ReturnType<typeof createSqlClient> | undefined;
  db: BunSQLDatabase<typeof schema> | undefined;
};

// For queries - reuse connection in development
const queryClient =
  globalForDb.queryClient ?? createSqlClient(connectionString, 10);
export const db = globalForDb.db ?? drizzle(queryClient, { schema });

if (Bun.env.NODE_ENV !== "production") {
  globalForDb.queryClient = queryClient;
  globalForDb.db = db;
}
