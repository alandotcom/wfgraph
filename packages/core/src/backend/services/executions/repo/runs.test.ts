/**
 * The SQL a run-repo method sends, read back through a driver that answers
 * nothing.
 *
 * A guard written into a `WHERE` is invisible to a service test, which stubs the
 * repo out entirely, and the suite has no database. `drizzle-orm/pg-proxy` runs
 * the query builder and hands the statement to a callback instead of a
 * connection, which is what lets the statement itself be an assertion.
 */

import { drizzle } from "drizzle-orm/pg-proxy";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { RovaDatabase } from "#src/backend/lib/db/index";
import type { Database } from "#src/backend/lib/effect/database";
import { makeRunsMethods } from "#src/backend/services/executions/repo/runs";

function captureStatements(): {
  database: Database["Service"];
  statements: string[];
} {
  const statements: string[] = [];
  const db = drizzle(async (query) => {
    statements.push(query);
    return { rows: [] };
  });

  return {
    statements,
    database: {
      query: (run) => Effect.promise(() => run(db as unknown as RovaDatabase)),
    },
  };
}

describe("requestCancelForEntity", () => {
  it("claims only a run carrying no cancel yet, so the first Cancel Event wins", async () => {
    const { database, statements } = captureStatements();

    await Effect.runPromise(
      makeRunsMethods(database).requestCancelForEntity({
        workflowId: "workflow_1",
        entityValue: "sub_9",
        runMode: "live",
        eventName: "billing/subscription.canceled",
        payload: { reason: "customer left" },
      })
    );

    expect(statements[0]).toContain('"cancel_requested_at" is null');
  });
});

describe("finishRun", () => {
  // The engine's function body is replayed on every attempt and after every
  // wait, so any elapsed it measures itself covers the last attempt alone. A run
  // that retried four times recorded 23ms against 4m46s of wall clock. The row
  // already holds when it started, so the duration is derived where both
  // timestamps live and no clock crosses the replay boundary.
  it("derives the duration from the row's own started_at", async () => {
    const { database, statements } = captureStatements();

    await Effect.runPromise(
      makeRunsMethods(database).finishRun({
        executionId: "exec_1",
        status: "failed",
        error: "boom",
      })
    );

    expect(statements[0]).toMatch(/"duration" = [^,]*started_at/i);
  });
});
