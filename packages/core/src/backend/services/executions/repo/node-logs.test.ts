/**
 * The two node-log queries a branch run brought with it, whose whole substance
 * is which rows they touch.
 *
 * Both are called with an execution id and nothing else, so the statement is the
 * only place their guard can be read.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { stubDatabase } from "#src/backend/lib/effect/test-layers";
import { makeNodeLogsMethods } from "#src/backend/services/executions/repo/node-logs";

describe("cancelOpenNodeLogs", () => {
  // A row a killed branch left behind is open; a row it closed is finished, and
  // rewriting one of those would take a run's own trace away from it.
  it.effect(
    "closes the open rows of one run and leaves the finished ones",
    () =>
      Effect.gen(function* () {
        const { service: database, statements } = stubDatabase();

        yield* makeNodeLogsMethods(database).cancelOpenNodeLogs("exec_1");

        const [statement] = statements;
        assert.include(statement?.query, 'update "workflow_execution_logs"');
        assert.include(statement?.query, '"status" in ');
        assert.include(statement?.params, "pending");
        assert.include(statement?.params, "running");
        assert.include(statement?.params, "cancelled");
        assert.include(statement?.params, "exec_1");
      })
  );
});

describe("readNodeOutputs", () => {
  // What a branch run reads the graph above its entry node from. A node that
  // failed handed nothing on, and a node still going has nothing to hand on yet.
  it.effect("reads back the rows of one run that succeeded", () =>
    Effect.gen(function* () {
      const { service: database, statements } = stubDatabase();

      yield* makeNodeLogsMethods(database).readNodeOutputs("exec_1");

      const [statement] = statements;
      assert.include(statement?.query, '"status" = ');
      assert.include(statement?.params, "success");
      assert.include(statement?.params, "exec_1");
    })
  );
});
