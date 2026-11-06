/**
 * What a failed PostgreSQL query carries out of `makeDatabaseLayer`: the SQL
 * text and the driver's code, and none of the values the query bound, which
 * can be an Event's payload.
 */

import { inspect } from "node:util";
import { expect, it } from "vitest";
import { Effect } from "effect";
import {
  hasDatabaseErrorCode,
  QueryFailed,
} from "#src/backend/lib/effect/database";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { usePersistenceRegistry } from "#src/backend/persistence/persistence-conformance-test-support";
import {
  describePostgres,
  sharedPostgresTestDatabase,
} from "#src/backend/persistence/postgres-test-database";

/** Values the failing insert binds, which no rendering of its error may hold. */
const PAYLOAD_SECRET = "4111-1111-1111-1111";
const KEY_SECRET = "wf_missing_8813";

describePostgres("a failed PostgreSQL query", () => {
  const shared = sharedPostgresTestDatabase();
  const { openConnection } = usePersistenceRegistry(
    shared.createDatabase,
    shared.teardown
  );

  it("keeps the SQL text and the driver's code, and drops every bound value", async () => {
    const connection = await openConnection();
    // No workflow has this id, so the foreign key refuses the row, and
    // PostgreSQL's own detail for that refusal quotes the key.
    const failure = await connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.recordAuditEvent({
          workflowId: KEY_SECRET,
          eventType: "run_refused",
          message: "Refused",
          metadata: { card: PAYLOAD_SECRET },
        })
      ).pipe(Effect.flip)
    );

    expect(hasDatabaseErrorCode(failure, "23503")).toBe(true);
    expect(failure.cause).toBeInstanceOf(QueryFailed);
    expect(failure.cause instanceof QueryFailed && failure.cause.query).toMatch(
      /^insert into "workflow_execution_events"/u
    );
    for (const rendered of [
      inspect(failure, { depth: null, showHidden: true }),
      JSON.stringify(failure),
      String(failure.cause),
    ]) {
      expect(rendered).not.toContain(PAYLOAD_SECRET);
      expect(rendered).not.toContain(KEY_SECRET);
    }
  });
});
