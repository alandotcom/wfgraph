/**
 * Which rows the Refused Starts panel is allowed to read.
 *
 * The scope is a `WHERE` over the event type, and every caller stubs this method
 * out, so `drizzle-orm/pg-proxy` is what makes the statement itself the
 * assertion (see `runs.test.ts` for the harness this follows).
 */

import { drizzle } from "drizzle-orm/pg-proxy";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { RovaDatabase } from "#src/backend/lib/db/index";
import * as schema from "#src/backend/lib/db/schema";
import type { Database } from "#src/backend/lib/effect/database";
import { makeAuditMethods } from "#src/backend/services/executions/repo/audit";

function captureStatements(): {
  database: Database["Service"];
  statements: { query: string; params: unknown[] }[];
} {
  const statements: { query: string; params: unknown[] }[] = [];
  const db = drizzle(
    async (query, params) => {
      statements.push({ query, params });
      return { rows: [] };
    },
    { schema }
  );

  return {
    statements,
    database: {
      query: (run) => Effect.promise(() => run(db as unknown as RovaDatabase)),
    },
  };
}

describe("listWorkflowEvents", () => {
  // A Refused Start has no run to be found through, so it is the type that
  // scopes the row to the workflow. Drop the filter and the panel shows every
  // run timeline entry the workflow ever wrote.
  it("reads only the types that belong to the workflow rather than a run", async () => {
    const { database, statements } = captureStatements();

    await Effect.runPromise(
      makeAuditMethods(database).listWorkflowEvents("wf_1")
    );

    const [statement] = statements;
    expect(statement?.query).toContain('"event_type" in');
    // The limit trails the filter, so the types are read off the front.
    expect(statement?.params.slice(0, 3)).toEqual([
      "wf_1",
      "run_not_started",
      "cancel_not_delivered",
    ]);
  });

  // The per-run timeline is keyed on the execution instead, and takes every
  // type: a run's own rows are already scoped by belonging to it.
  it("reads a run's timeline by execution id alone", async () => {
    const { database, statements } = captureStatements();

    await Effect.runPromise(makeAuditMethods(database).listEvents("exec_1"));

    expect(statements[0]?.params.slice(0, 1)).toEqual(["exec_1"]);
    expect(statements[0]?.query).not.toContain('"event_type" in');
  });
});
