import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
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

const schema: {
  workflows: typeof workflows;
  workflowExecutions: typeof workflowExecutions;
  workflowExecutionLogs: typeof workflowExecutionLogs;
  workflowExecutionEvents: typeof workflowExecutionEvents;
  workflowExecutionsRelations: typeof workflowExecutionsRelations;
  workflowWaitStates: typeof workflowWaitStates;
  apiKeys: typeof apiKeys;
  integrations: typeof integrations;
} = {
  workflows,
  workflowExecutions,
  workflowExecutionLogs,
  workflowExecutionEvents,
  workflowExecutionsRelations,
  workflowWaitStates,
  apiKeys,
  integrations,
};

/**
 * The Drizzle handle, with this app's tables attached. The `Database` service in
 * `backend/lib/effect/database.ts` hands one of these to every query it runs.
 */
export type RovaDatabase = PostgresJsDatabase<typeof schema>;

const DEFAULT_DATABASE_URL =
  "postgresql://workflow:workflow@localhost:55437/workflow_builder";
const DEFAULT_QUERY_CONNECTIONS = 10;
const DEFAULT_MIGRATION_CONNECTIONS = 1;

export type DatabaseRuntimeConfig = {
  url: string;
  maxConnections?: number;
  migrationConnections?: number;
};

const createSqlClient = (url: string, max: number): Sql =>
  postgres(url, { max });

type DatabaseRuntimeState = {
  config: DatabaseRuntimeConfig | null;
  queryClient: Sql | null;
  migrationClient: Sql | null;
  db: PostgresJsDatabase<typeof schema> | null;
};

declare global {
  var __rovaDatabaseState: DatabaseRuntimeState | undefined;
}

const databaseState: DatabaseRuntimeState = globalThis.__rovaDatabaseState ?? {
  config: null,
  queryClient: null,
  migrationClient: null,
  db: null,
};

globalThis.__rovaDatabaseState = databaseState;

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
  const url = configuredUrl || process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

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

function normalizeRuntimeConfig(
  config: DatabaseRuntimeConfig
): Required<DatabaseRuntimeConfig> {
  return {
    url: config.url.trim(),
    maxConnections: normalizeConnectionCount(
      config.maxConnections,
      DEFAULT_QUERY_CONNECTIONS
    ),
    migrationConnections: normalizeConnectionCount(
      config.migrationConnections,
      DEFAULT_MIGRATION_CONNECTIONS
    ),
  };
}

function areConfigsEquivalent(
  left: Required<DatabaseRuntimeConfig>,
  right: Required<DatabaseRuntimeConfig>
): boolean {
  return (
    left.url === right.url &&
    left.maxConnections === right.maxConnections &&
    left.migrationConnections === right.migrationConnections
  );
}

export function configureDatabaseRuntime(config: DatabaseRuntimeConfig): void {
  const normalizedConfig = normalizeRuntimeConfig(config);
  if (!normalizedConfig.url) {
    throw new Error("Database configuration requires a non-empty url.");
  }

  if (databaseState.config && !databaseState.db && !databaseState.queryClient) {
    databaseState.config = normalizedConfig;
    return;
  }

  if (
    databaseState.db ||
    databaseState.queryClient ||
    databaseState.migrationClient
  ) {
    const currentConfig = resolveDatabaseConfig();
    if (areConfigsEquivalent(currentConfig, normalizedConfig)) {
      return;
    }

    throw new Error(
      "Database runtime is already initialized with a different configuration. Restart the process to apply a new database config."
    );
  }

  databaseState.config = normalizedConfig;
}

export function getDb(): PostgresJsDatabase<typeof schema> {
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

export function getMigrationClient(): Sql {
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

const dbProxy: PostgresJsDatabase<typeof schema> = new Proxy(
  Object.create(null),
  {
    get(_target, property, receiver) {
      const instance = getDb();
      const value = Reflect.get(instance, property, receiver);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  }
);

export const db: PostgresJsDatabase<typeof schema> = dbProxy;
