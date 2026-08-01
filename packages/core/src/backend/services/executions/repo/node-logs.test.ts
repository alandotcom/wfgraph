/**
 * The two node-log queries a branch run brought with it, whose whole substance
 * is which rows they touch.
 *
 * Both are called with an execution id and nothing else, so the statement is the
 * only place their guard can be read.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { stubDatabase } from "#src/backend/lib/effect/test-layers";
import { makeNodeLogsMethods } from "#src/backend/services/executions/repo/node-logs";

describe("cancelOpenNodeLogs", () => {
  // A row a killed branch left behind is open; a row it closed is finished, and
  // rewriting one of those would take a run's own trace away from it.
  it("closes the open rows of one run and leaves the finished ones", async () => {
    const { service: database, statements } = stubDatabase();

    await Effect.runPromise(
      makeNodeLogsMethods(database).cancelOpenNodeLogs("exec_1")
    );

    const [statement] = statements;
    expect(statement?.query).toContain('update "workflow_execution_logs"');
    expect(statement?.query).toContain('"status" in ');
    expect(statement?.params).toContain("pending");
    expect(statement?.params).toContain("running");
    expect(statement?.params).toContain("cancelled");
    expect(statement?.params).toContain("exec_1");
  });
});

describe("readNodeOutputs", () => {
  // What a branch run reads the graph above its entry node from. A node that
  // failed handed nothing on, and a node still going has nothing to hand on yet.
  it("reads back the rows of one run that succeeded", async () => {
    const { service: database, statements } = stubDatabase();

    await Effect.runPromise(
      makeNodeLogsMethods(database).readNodeOutputs("exec_1")
    );

    const [statement] = statements;
    expect(statement?.query).toContain('"status" = ');
    expect(statement?.params).toContain("success");
    expect(statement?.params).toContain("exec_1");
  });
});
