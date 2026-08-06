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

describe("findSummaryWithPinnedGraph", () => {
  // Every run pins a version, so the logs overlay joins inner — a missing
  // version is absence of the run, not detail-without-overlay. Joining on the
  // wrong key, or dropping `graph` from the select, still answers a row and
  // the service would only learn the overlay was wrong after a human opened it.
  it("selects graph by inner-joining versions on workflow_version_id", async () => {
    const { service: database, statements } = stubDatabase();

    await Effect.runPromise(
      makeRunsMethods(database).findSummaryWithPinnedGraph("exec_1")
    );

    const [statement] = statements;
    expect(statement?.query).toContain('"workflow_versions"."graph"');
    expect(statement?.query).toContain(
      'inner join "workflow_versions" on "workflow_executions"."workflow_version_id" = "workflow_versions"."id"'
    );
    expect(statement?.query).not.toContain(
      '"workflow_executions"."workflow_version_id" = "workflow_versions"."workflow_id"'
    );
    expect(statement?.params).toContain("exec_1");
  });
});
