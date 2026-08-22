/**
 * The SQL a run-repo method sends, read back through a driver that answers
 * nothing.
 *
 * A guard written into a `WHERE` is invisible to a service test, which stubs the
 * repo out entirely, and the suite has no database. That leaves the statement
 * itself as the only thing left to assert on.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { stubDatabase } from "#src/backend/lib/effect/test-layers";
import { makeRunsMethods } from "#src/backend/services/executions/repo/runs";

describe("requestCancelForEntity", () => {
  it("claims only a run carrying no cancel yet, so the first Cancel Event wins", async () => {
    const { service: database, statements } = stubDatabase();

    await Effect.runPromise(
      makeRunsMethods(database).requestCancelForEntity({
        workflowId: "workflow_1",
        entityValue: "sub_9",
        runMode: "live",
        eventName: "billing/subscription.canceled",
        payload: { reason: "customer left" },
      })
    );

    expect(statements[0]?.query).toContain('"cancel_requested_at" is null');
  });
});

describe("finishRun", () => {
  // The engine's function body is replayed on every attempt and after every
  // wait, so any elapsed it measures itself covers the last attempt alone. A run
  // that retried four times recorded 23ms against 4m46s of wall clock. The row
  // already holds when it started, so the duration is derived where both
  // timestamps live and no clock crosses the replay boundary.
  it("derives the duration from the row's own started_at", async () => {
    const { service: database, statements } = stubDatabase();

    await Effect.runPromise(
      makeRunsMethods(database).finishRun({
        executionId: "exec_1",
        status: "failed",
        error: "boom",
      })
    );

    expect(statements[0]?.query).toMatch(/"duration" = [^,]*started_at/i);
  });
});

describe("listByWorkflow", () => {
  it("does not read the JSONB columns the list never shows", async () => {
    const { service: database, statements } = stubDatabase();

    await Effect.runPromise(
      makeRunsMethods(database).listByWorkflow({
        workflowId: "wf_1",
        includeSuperseded: false,
      })
    );

    const [statement] = statements;
    expect(statement?.query).not.toMatch(/"input"/);
    expect(statement?.query).not.toMatch(/"output"/);
    expect(statement?.query).not.toMatch(/"cancel_payload"/);
    expect(statement?.query).toContain('"status"');
    expect(statement?.params).toContain("wf_1");
  });
});

describe("listPage", () => {
  it("does not read the JSONB columns the list never shows", async () => {
    const { service: database, statements } = stubDatabase();

    await Effect.runPromise(makeRunsMethods(database).listPage({ limit: 10 }));

    const [statement] = statements;
    expect(statement?.query).not.toMatch(/"input"/);
    expect(statement?.query).not.toMatch(/"output"/);
    expect(statement?.query).not.toMatch(/"cancel_payload"/);
    expect(statement?.query).toContain('"workflow_executions"');
  });
});
