/**
 * Which rows the Refused Starts panel is allowed to read.
 *
 * The scope is a `WHERE` over the event type, and every caller stubs this method
 * out, which leaves the statement itself as the assertion.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { stubDatabase } from "#src/backend/lib/effect/test-layers";
import { makeAuditMethods } from "#src/backend/services/executions/repo/audit";

describe("listWorkflowEvents", () => {
  // A Refused Start has no run to be found through, so it is the type that
  // scopes the row to the workflow. Drop the filter and the panel shows every
  // run timeline entry the workflow ever wrote.
  it.effect(
    "reads only the types that belong to the workflow rather than a run",
    () =>
      Effect.gen(function* () {
        const { service: database, statements } = stubDatabase();

        yield* makeAuditMethods(database).listWorkflowEvents("wf_1");

        const [statement] = statements;
        assert.include(statement?.query, '"event_type" in');
        // The limit trails the filter, so the types are read off the front.
        assert.deepStrictEqual(statement?.params.slice(0, 3), [
          "wf_1",
          "run_refused",
          "cancel_not_delivered",
        ]);
      })
  );
});
