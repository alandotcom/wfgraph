/**
 * What the serialized start decides, read back through a driver that answers with
 * rows the test chose.
 *
 * The decision lives in a `WHERE` and in the order the statements go out, neither
 * of which a service test can see: it stubs the whole repo. So the statement and
 * the sequence are the assertion here.
 */

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { stubDatabase } from "#src/backend/lib/effect/test-layers";
import {
  type EntityStartOutcome,
  ExecutionRepo,
  ExecutionRepoLayer,
} from "#src/backend/services/executions/repo/index";

/** One row of the in-flight candidate query, in the order it selects columns. */
type InFlightRow = [id: string, enqueuedAt: Date | null, startedAt: Date];

function isInFlightQuery(query: string): boolean {
  return query.includes('"enqueued_at", "started_at"');
}

function isDeliveryLookup(query: string): boolean {
  return query.startsWith("select") && query.includes('"delivery_id" = $2');
}

function isLock(query: string): boolean {
  return query.includes("pg_advisory_xact_lock");
}

function harness(answers: {
  ownRow?: boolean;
  inFlight?: InFlightRow[];
  updated?: string[];
  transactionFailures?: readonly unknown[];
}) {
  const {
    layer: databaseLayer,
    statements,
    transactions,
  } = stubDatabase(
    ({ query }) => {
      if (isDeliveryLookup(query)) {
        return answers.ownRow ? [["exec_own"]] : [];
      }
      if (isInFlightQuery(query)) {
        return answers.inFlight ?? [];
      }
      if (query.startsWith("update")) {
        return (answers.updated ?? []).map((id) => [id]);
      }
      if (query.startsWith("insert")) {
        return [["exec_new"]];
      }
      return [];
    },
    { transactionFailures: answers.transactionFailures }
  );

  // `null` is how a case asks for a start carrying no delivery: an explicit
  // `undefined` would take the default instead.
  const start = (
    concurrency: "first-wins" | "newest-wins" | "unlimited",
    deliveryId: string | null = "dlv_1"
  ): Promise<EntityStartOutcome> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* ExecutionRepo;
        return yield* repo.startForEntity({
          execution: {
            workflowId: "wf_1",
            workflowVersionId: "ver_1",
            startSource: "event",
            runMode: "live",
            entityValue: "appt_1",
            input: {},
            deliveryId: deliveryId ?? undefined,
          },
          concurrency,
          supersededReason: "Superseded by a newer start",
        });
      }).pipe(
        Effect.provide(ExecutionRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

  const sent = (predicate: (query: string) => boolean) =>
    statements.find((statement) => predicate(statement.query));

  const sentAny = (predicate: (query: string) => boolean) =>
    statements.some((statement) => predicate(statement.query));

  return { sent, sentAny, start, transactions };
}

describe("startForEntity", () => {
  // Two reschedules arriving together otherwise both read an empty in-flight set
  // and both start. PostgreSQL's predicate locks detect that write skew at
  // SERIALIZABLE and abort one whole decision for retry.
  it("runs the entity decision in a serializable transaction", async () => {
    const { sentAny, start, transactions } = harness({});

    await start("newest-wins");

    expect(transactions).toEqual([{ isolationLevel: "serializable" }]);
    expect(sentAny(isLock)).toBe(false);
  });

  // What a real driver raises is nested: Drizzle wraps the failure in a
  // DrizzleQueryError carrying the SQL it ran, and the PostgresError holding the
  // SQLSTATE sits under that. Reading the first link alone matched only the
  // shape above, which nothing outside this file produces, so every aborted
  // start failed its node instead of retrying.
  it("retries when the code sits under a driver wrapper", async () => {
    const { start, transactions } = harness({
      transactionFailures: [{ cause: { code: "40001" } }],
    });

    const outcome = await start("first-wins");

    expect(outcome.status).toBe("started");
    expect(transactions).toHaveLength(2);
  });

  // A failure that is not a serialization abort is the caller's to see, however
  // deep it sits, or a genuine outage would be retried four times and then
  // reported as though it had been a race.
  it("does not retry an unrelated failure carried the same way", async () => {
    const { start, transactions } = harness({
      transactionFailures: [{ cause: { code: "23505" } }],
    });

    await expect(start("first-wins")).rejects.toBeDefined();
    expect(transactions).toHaveLength(1);
  });

  // Unlimited compares nothing, so a lock would only make concurrent starts of
  // one entity queue up behind each other for no decision.
  it("takes no lock where nothing is compared", async () => {
    const { sentAny, start } = harness({});

    await start("unlimited");

    expect(sentAny(isLock)).toBe(false);
  });

  // A start with nothing to serialize on cannot be replayed by a retry loop, so
  // it carries no delivery id and asks no lookup.
  it("skips the arrival lookup for a start that carries no delivery", async () => {
    const { sentAny, start } = harness({});

    await start("first-wins", null);

    expect(sentAny(isDeliveryLookup)).toBe(false);
  });
});

/**
 * The same harness, for the other cross-table method. What is pinned is which
 * tables the deletion names: the run rows carry logs and wait states with them by
 * `ON DELETE cascade`, and naming those tables again meant first reading every
 * execution id into the application and re-sending it as one bind parameter each.
 */
function deleteHarness() {
  const { layer: databaseLayer, statements } = stubDatabase();

  const run = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* ExecutionRepo;
        return yield* repo.deleteAllForWorkflow("wf_1");
      }).pipe(
        Effect.provide(ExecutionRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

  return { run, statements };
}

describe("deleteAllForWorkflow", () => {
  it("deletes the audit rows and the runs, by workflow id, and nothing else", async () => {
    const { run, statements } = deleteHarness();

    await run();

    expect(statements).toHaveLength(2);
    expect(statements[0]?.query).toContain(
      'delete from "workflow_execution_events"'
    );
    expect(statements[1]?.query).toContain('delete from "workflow_executions"');
    for (const statement of statements) {
      expect(statement.query).toContain('"workflow_id" = $1');
      expect(statement.params).toEqual(["wf_1"]);
    }
  });

  // The pre-read this replaces bound one parameter per run, which stops working
  // at the protocol's 65535 and shipped every id twice over the wire.
  it("names no execution id and no cascading table", async () => {
    const { run, statements } = deleteHarness();

    await run();

    const queries = statements.map((statement) => statement.query).join("\n");
    expect(queries).not.toContain("workflow_execution_logs");
    expect(queries).not.toContain("workflow_wait_states");
    expect(queries).not.toContain('"id" in');
  });
});
