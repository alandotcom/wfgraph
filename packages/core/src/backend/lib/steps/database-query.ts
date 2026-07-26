/**
 * Executable step function for Database Query action
 *
 * SECURITY PATTERN - External Secret Store:
 * Step fetches credentials using an integration ID reference
 */

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import { validateWorkflowOutputAgainstSchema } from "@/shared/workflow/schema-validation";
import { type StepInput, withStepLogging } from "./step-handler";

type DatabaseQueryResult =
  | { success: true; rows: unknown; count: number }
  | { success: false; error: string };

export type DatabaseQueryInput = StepInput & {
  integrationId?: string;
  dbQuery?: string;
  query?: string;
  dbOutputSchema?: string;
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

function createDatabaseClient(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 20,
  });
}

async function executeQuery(
  client: Sql,
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

async function cleanupClient(client: Sql | null): Promise<void> {
  if (client) {
    try {
      await client.end();
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

  let client: Sql | null = null;

  try {
    client = createDatabaseClient(databaseUrl);
    const result = await executeQuery(client, queryResult.queryString);
    await client.end();

    const output = {
      success: true as const,
      rows: result,
      count: Array.isArray(result) ? result.length : 0,
    };
    const schemaValidation = validateWorkflowOutputAgainstSchema({
      schemaValue: input.dbOutputSchema,
      output,
      contextLabel: "Database Query",
    });

    if (!schemaValidation.ok) {
      return {
        success: false,
        error: schemaValidation.error,
      };
    }

    return {
      success: output.success,
      rows: output.rows,
      count: output.count,
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
