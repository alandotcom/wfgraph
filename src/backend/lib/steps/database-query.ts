/**
 * Executable step function for Database Query action
 *
 * SECURITY PATTERN - External Secret Store:
 * Step fetches credentials using an integration ID reference
 */

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "./step-handler";

type DatabaseQueryResult =
  | { success: true; rows: unknown; count: number }
  | { success: false; error: string };

export type DatabaseQueryInput = StepInput & {
  integrationId?: string;
  dbQuery?: string;
  query?: string;
};

function resolveQueryString(
  input: DatabaseQueryInput
): { ok: true; queryString: string } | { ok: false; error: string } {
  const queryString = input.dbQuery ?? input.query;
  if (!queryString || queryString.trim() === "") {
    return { ok: false, error: "SQL query is required" };
  }
  return { ok: true, queryString };
}

function createDatabaseClient(databaseUrl: string) {
  return new Bun.SQL(databaseUrl, {
    max: 1,
    connectionTimeout: 10,
    idleTimeout: 20,
  });
}

async function executeQuery(
  client: ReturnType<typeof createDatabaseClient>,
  queryString: string
): Promise<unknown> {
  const db = drizzle(client);
  return await db.execute(sql.raw(queryString));
}

function getDatabaseErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown database error";
  }

  const errorMessage = error.message;

  if (errorMessage.includes("ECONNREFUSED")) {
    return "Connection refused. Please check your database URL and ensure the database is running.";
  }
  if (errorMessage.includes("ENOTFOUND")) {
    return "Database host not found. Please check your database URL.";
  }
  if (errorMessage.includes("authentication failed")) {
    return "Authentication failed. Please check your database credentials.";
  }
  if (errorMessage.includes("does not exist")) {
    return `Database error: ${errorMessage}`;
  }

  return errorMessage;
}

async function cleanupClient(
  client: ReturnType<typeof createDatabaseClient> | null
): Promise<void> {
  if (client) {
    try {
      await client.close();
    } catch {
      // Ignore errors during cleanup
    }
  }
}

/**
 * Database query logic
 */
async function databaseQuery(
  input: DatabaseQueryInput
): Promise<DatabaseQueryResult> {
  const queryResult = resolveQueryString(input);
  if (!queryResult.ok) {
    return { success: false, error: queryResult.error };
  }

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  const databaseUrl = credentials.DATABASE_URL;

  if (!databaseUrl) {
    return {
      success: false,
      error:
        "DATABASE_URL is not configured. Please add it in Project Integrations.",
    };
  }

  let client: ReturnType<typeof createDatabaseClient> | null = null;

  try {
    client = createDatabaseClient(databaseUrl);
    const result = await executeQuery(client, queryResult.queryString);
    await client.close();

    return {
      success: true,
      rows: result,
      count: Array.isArray(result) ? result.length : 0,
    };
  } catch (error) {
    await cleanupClient(client);
    return {
      success: false,
      error: `Database query failed: ${getDatabaseErrorMessage(error)}`,
    };
  }
}

/**
 * Database Query Step
 * Executes a SQL query against a PostgreSQL database
 */
export function databaseQueryStep(
  input: DatabaseQueryInput
): Promise<DatabaseQueryResult> {
  return withStepLogging(input, () => databaseQuery(input));
}
databaseQueryStep.maxRetries = 0;
