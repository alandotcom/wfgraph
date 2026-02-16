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

const DEFAULT_DATABASE_URL =
  "postgresql://workflow:workflow@localhost:55437/workflow_builder";
const DEFAULT_QUERY_CONNECTIONS = 10;
const DEFAULT_MIGRATION_CONNECTIONS = 1;

export type DatabaseRuntimeConfig = {
  url: string;
  maxConnections?: number;
  migrationConnections?: number;
};

const createSqlClient = (url: string, max: number) => new Bun.SQL(url, { max });

type DatabaseRuntimeState = {
  config: DatabaseRuntimeConfig | null;
  queryClient: ReturnType<typeof createSqlClient> | null;
  migrationClient: ReturnType<typeof createSqlClient> | null;
  db: BunSQLDatabase<typeof schema> | null;
};

const globalForDb = globalThis as unknown as {
  __rovaDatabaseState?: DatabaseRuntimeState;
};

const databaseState: DatabaseRuntimeState = globalForDb.__rovaDatabaseState ?? {
  config: null,
  queryClient: null,
  migrationClient: null,
  db: null,
};

globalForDb.__rovaDatabaseState = databaseState;

function normalizeConnectionCount(
  value: number | undefined,
  fallback: number
): number {
  if (!value || Number.isNaN(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function resolveDatabaseConfig(): Required<DatabaseRuntimeConfig> {
  const configured = databaseState.config;
  const configuredUrl = configured?.url?.trim();
  const url = configuredUrl || Bun.env.DATABASE_URL || DEFAULT_DATABASE_URL;

  return {
    url,
    maxConnections: normalizeConnectionCount(
      configured?.maxConnections,
      DEFAULT_QUERY_CONNECTIONS
    ),
    migrationConnections: normalizeConnectionCount(
      configured?.migrationConnections,
      DEFAULT_MIGRATION_CONNECTIONS
    ),
  };
}

function assertConfigurable(): void {
  if (
    databaseState.db ||
    databaseState.queryClient ||
    databaseState.migrationClient
  ) {
    throw new Error(
      "Database runtime is already initialized. Call configureDatabaseRuntime(...) before first database use."
    );
  }
}

export function configureDatabaseRuntime(config: DatabaseRuntimeConfig): void {
  const url = config.url.trim();
  if (!url) {
    throw new Error("Database configuration requires a non-empty url.");
  }

  assertConfigurable();

  databaseState.config = {
    ...config,
    url,
  };
}

export function getDb(): BunSQLDatabase<typeof schema> {
  if (databaseState.db) {
    return databaseState.db;
  }

  const config = resolveDatabaseConfig();
  databaseState.queryClient = createSqlClient(
    config.url,
    config.maxConnections
  );
  databaseState.db = drizzle(databaseState.queryClient, { schema });

  return databaseState.db;
}

export function getMigrationClient(): ReturnType<typeof createSqlClient> {
  if (databaseState.migrationClient) {
    return databaseState.migrationClient;
  }

  const config = resolveDatabaseConfig();
  databaseState.migrationClient = createSqlClient(
    config.url,
    config.migrationConnections
  );

  return databaseState.migrationClient;
}

export const db = new Proxy({} as BunSQLDatabase<typeof schema>, {
  get(_target, property, receiver) {
    const instance = getDb() as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(instance, property, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
