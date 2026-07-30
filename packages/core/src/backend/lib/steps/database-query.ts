/**
 * Database Query: the engine's own action for reading a host's own database.
 *
 * The connection comes from the `database` integration a node names, so the URL
 * is fetched by id at run time and never travels in the node's config. The
 * payload is `{ rows, count }`, which is what the editor's picker offers and
 * what a downstream template addresses.
 */

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { Effect, Schema } from "effect";
import postgres, { type Sql } from "postgres";
import { defineStep, StepFailure } from "#src/backend/lib/steps/define-step";
import { validateWorkflowOutputAgainstSchema } from "@rova/shared/workflow/schema-validation";

export const databaseQueryInput = Schema.Struct({
  dbQuery: Schema.optionalKey(Schema.String),
  /** What the editor's older panel wrote the SQL under. */
  query: Schema.optionalKey(Schema.String),
  dbOutputSchema: Schema.optionalKey(Schema.String),
});

export const databaseQueryOutput = Schema.Struct({
  rows: Schema.Array(Schema.Unknown).annotate({
    description: "Query result rows",
  }),
  count: Schema.Number.annotate({ description: "Number of rows" }).check(
    Schema.isFinite()
  ),
});

type DatabaseQueryInput = typeof databaseQueryInput.Type;
type DatabaseQueryOutput = typeof databaseQueryOutput.Type;

function createDatabaseClient(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 20,
  });
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

/**
 * Runs the query on a connection of its own and gives the socket back.
 *
 * The pool is opened per call rather than kept: this reaches whichever database
 * the node's integration names, which is not the one Rova's own tables live in
 * and may differ from node to node.
 */
async function runQuery(
  databaseUrl: string,
  queryString: string
): Promise<readonly unknown[]> {
  const client = createDatabaseClient(databaseUrl);

  try {
    const result = await drizzle(client).execute(sql.raw(queryString));
    // postgres.js answers with an array subclass carrying its own fields, which
    // JSONB and Inngest's memoization would drop; the spread is what makes the
    // rows a plain array before either sees them.
    return Array.isArray(result) ? [...result] : [];
  } finally {
    await client.end().catch(() => undefined);
  }
}

function readQueryString(input: DatabaseQueryInput): string | undefined {
  const queryString = (input.dbQuery ?? input.query ?? "").trim();
  return queryString || undefined;
}

export const databaseQueryStep = defineStep({
  label: "Database Query",
  description: "Query your database",
  category: "System",
  // The editor configures this node through a panel of its own, so there is no
  // declarative field list to render.
  configFields: [],
  input: databaseQueryInput,
  output: databaseQueryOutput,
  handler: Effect.fn(function* (input, context) {
    const queryString = readQueryString(input);
    if (!queryString) {
      return yield* Effect.fail(
        new StepFailure({ message: "SQL query is required" })
      );
    }

    const credentials = yield* context.credentials;
    const databaseUrl = credentials.DATABASE_URL;
    if (!databaseUrl) {
      return yield* Effect.fail(
        new StepFailure({
          message:
            "DATABASE_URL is not configured. Please add it in Project Integrations.",
        })
      );
    }

    const rows = yield* Effect.tryPromise({
      try: () => runQuery(databaseUrl, queryString),
      catch: (error) =>
        new StepFailure({
          message: `Database query failed: ${getDatabaseErrorMessage(error)}`,
        }),
    });

    const output: DatabaseQueryOutput = { rows, count: rows.length };
    const schemaValidation = validateWorkflowOutputAgainstSchema({
      schemaValue: input.dbOutputSchema,
      output,
      contextLabel: "Database Query",
    });

    if (!schemaValidation.ok) {
      return yield* Effect.fail(
        new StepFailure({ message: schemaValidation.error })
      );
    }

    return output;
  }),
});
