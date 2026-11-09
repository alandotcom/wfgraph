/**
 * The SQL a run-repo method sends, read back through a driver that answers
 * nothing.
 *
 * A guard written into a `WHERE` is invisible to a service test, which stubs the
 * repo out entirely, and the suite has no database. That leaves the statement
 * itself as the only thing left to assert on.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { stubDatabase } from "#src/backend/lib/effect/test-layers";
import { makeRunsMethods } from "#src/backend/services/executions/repo/runs";

describe("listByWorkflow", () => {
  it.effect("does not read the JSONB columns the list never shows", () =>
    Effect.gen(function* () {
      const { service: database, statements } = stubDatabase();

      yield* makeRunsMethods(database).listByWorkflow({
        workflowId: "wf_1",
        includeSuperseded: false,
      });

      const [statement] = statements;
      assert.notMatch(statement?.query, /"input"/);
      assert.notMatch(statement?.query, /"output"/);
      assert.notMatch(statement?.query, /"cancel_payload"/);
      assert.include(statement?.query, '"status"');
      assert.include(statement?.params, "wf_1");
    })
  );
});

describe("pinned version joins", () => {
  // The panel labels a draft run from the version it pinned. Reading the graph
  // to find that out would defeat the point of the thin list row.
  it.effect("joins the pinned version on all three run reads", () =>
    Effect.gen(function* () {
      const { service: database, statements } = stubDatabase();
      const runs = makeRunsMethods(database);

      yield* runs.listByWorkflow({
        workflowId: "wf_1",
        includeSuperseded: false,
      });
      yield* runs.listPage({ limit: 10 });
      yield* runs.findSummaryById("exec_1");

      for (const statement of statements) {
        assert.include(statement.query, '"workflow_versions"."kind"');
        assert.include(statement.query, '"workflow_version_id"');
      }
      assert.lengthOf(statements, 3);
    })
  );
});

describe("listPage", () => {
  it.effect("does not read the JSONB columns the list never shows", () =>
    Effect.gen(function* () {
      const { service: database, statements } = stubDatabase();

      yield* makeRunsMethods(database).listPage({ limit: 10 });

      const [statement] = statements;
      assert.notMatch(statement?.query, /"input"/);
      assert.notMatch(statement?.query, /"output"/);
      assert.notMatch(statement?.query, /"cancel_payload"/);
      assert.include(statement?.query, '"workflow_executions"');
    })
  );
});
