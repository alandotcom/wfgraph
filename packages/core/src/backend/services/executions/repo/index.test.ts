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

/** One row of the in-flight candidate query, which selects the id alone. */
type InFlightRow = [id: string];

function isInFlightQuery(query: string): boolean {
  return query.startsWith("select") && query.includes('"run_mode" = ');
}

function isDeliveryLookup(query: string): boolean {
  return query.startsWith("select") && query.includes('"delivery_id" = $2');
}

/** The exclusive Entity lock a Cancel claim takes. */
function isLock(query: string): boolean {
  return /pg_(try_)?advisory_xact_lock\(/.test(query);
}

/** The shared Entity lock an Event start takes, so a Cancel waits on it. */
function isSharedLock(query: string): boolean {
  return /pg_(try_)?advisory_xact_lock_shared\(/.test(query);
}

function harness(answers: {
  /** What each try of the shared lock answers, in order; true once spent. */
  locked?: boolean | boolean[] | undefined;
  ownRow?: boolean | undefined;
  inFlight?: InFlightRow[] | undefined;
  updated?: string[] | undefined;
  transactionFailures?: readonly unknown[] | undefined;
}) {
  const {
    layer: databaseLayer,
    statements,
    transactions,
  } = stubDatabase(
    ({ query }) => {
      if (query.includes("pg_try_advisory_xact_lock_shared")) {
        const answer = Array.isArray(answers.locked)
          ? (answers.locked.shift() ?? true)
          : (answers.locked ?? true);
        // A raw statement's rows reach the caller as the driver sent them.
        return [{ locked: answer }];
      }
      if (query.startsWith("do $$")) {
        throw Object.assign(new Error("waited for the lock"), {
          code: "40001",
        });
      }
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
          startedEntry: {
            message: "Event-triggered run started",
            metadata: {},
          },
          now: new Date("2026-03-01T09:00:00.000Z"),
        });
      }).pipe(
        Effect.provide(ExecutionRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

  const sent = (predicate: (query: string) => boolean) =>
    statements.find((statement) => predicate(statement.query));

  const sentAny = (predicate: (query: string) => boolean) =>
    statements.some((statement) => predicate(statement.query));

  return { sent, sentAny, start, statements, transactions };
}

describe("startForEntity", () => {
  // Two reschedules arriving together otherwise both read an empty in-flight set
  // and both start. PostgreSQL's predicate locks detect that write skew at
  // SERIALIZABLE and abort one whole decision for retry.
  it("runs the entity decision in a serializable transaction", async () => {
    const { statements, sentAny, start, transactions } = harness({
      locked: true,
    });

    await start("newest-wins");

    expect(transactions).toEqual([{ isolationLevel: "serializable" }]);
    expect(sentAny(isLock)).toBe(false);
    // The shared Entity lock is tried as the transaction's first statement,
    // before the snapshot every later read uses is taken.
    expect(statements[0]?.query).toMatch(/pg_try_advisory_xact_lock_shared/);
  });

  // What a real driver raises is nested: Drizzle wraps the failure in a
  // `DrizzleQueryError` carrying the SQL it ran, and the `PostgresError`
  // holding the SQLSTATE sits under that. Reading the first link alone matched
  // only a top-level `{ code }`, which nothing outside this file produces, so
  // every aborted start failed its node instead of retrying.
  it("retries when the code sits under a driver wrapper", async () => {
    const { start, transactions } = harness({
      transactionFailures: [{ cause: { code: "40001" } }],
    });

    const outcome = await start("first-wins");

    expect(outcome.status).toBe("started");
    expect(transactions).toHaveLength(2);
  });

  // A detected deadlock rolls back the whole transaction just as a
  // serialization failure does, so the decision runs again from the start.
  it("retries a deadlock abort", async () => {
    const { start, transactions } = harness({
      transactionFailures: [{ cause: { code: "40P01" } }],
    });

    const outcome = await start("newest-wins");

    expect(outcome.status).toBe("started");
    expect(transactions).toHaveLength(2);
  });

  // A failure that is not a serialization abort is the caller's to see, however
  // deep it sits. Otherwise a genuine outage would be retried out and then
  // reported as though it had been a race.
  it("does not retry an unrelated failure carried the same way", async () => {
    const { start, transactions } = harness({
      transactionFailures: [{ cause: { code: "23505" } }],
    });

    await expect(start("first-wins")).rejects.toBeDefined();
    expect(transactions).toHaveLength(1);
  });

  // Unlimited compares no runs, so a start takes only the shared lock a
  // Cancel claim of its Entity waits on: concurrent starts of one entity do
  // not queue up behind each other.
  it("takes only the shared Entity lock where no runs are compared", async () => {
    const { sentAny, start } = harness({});

    await start("unlimited");

    expect(sentAny(isLock)).toBe(false);
    expect(sentAny(isSharedLock)).toBe(true);
  });

  // A shared lock a Cancel claim already holds means the attempt's snapshot
  // predates that claim, so the attempt waits for it and starts again.
  it("starts the decision again once a Cancel claim it waited on has committed", async () => {
    const { start, transactions } = harness({ locked: [false, true] });

    const outcome = await start("newest-wins");

    expect(outcome.status).toBe("started");
    expect(transactions).toHaveLength(2);
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
 * The same harness, for the other cross-table method. What is pinned is the
 * batch: how many runs one transaction takes, the order it locks them in, and
 * which tables the deletion names. The run rows carry logs and wait states
 * with them by `ON DELETE cascade`, so no statement names those tables.
 */
function deleteHarness(chosenPerBatch: readonly number[]) {
  const batches = [...chosenPerBatch];
  const { layer: databaseLayer, statements } = stubDatabase(
    ({ query, params }) => {
      if (isRunChooser(query)) {
        const size = batches.shift() ?? 0;
        return Array.from({ length: size }, (_, index) => [`exec_${index}`]);
      }
      if (query.startsWith('delete from "workflow_executions"')) {
        return params.map((id) => [id]);
      }
      return [];
    }
  );

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

/** The statement choosing one batch's runs. */
function isRunChooser(query: string): boolean {
  return (
    query.startsWith('select "id" from "workflow_executions"') &&
    query.includes('"workflow_id" = $1') &&
    !query.includes("for update")
  );
}

describe("deleteAllForWorkflow", () => {
  // A pass's fenced write holds its schedule row before it writes the
  // execution row, so each batch takes its runs' schedule rows first too.
  // The run sweep holds an execution row before its cascade reaches the run's
  // audit rows, so each batch takes its execution rows before it deletes them.
  it("deletes runs in batches of 500, each locking its schedule rows, then its runs, before deleting them", async () => {
    const { run, statements } = deleteHarness([500, 2]);

    const deleted = await run();

    expect(deleted).toBe(502);
    const queries = statements.map((statement) => statement.query);
    const choosers = statements.filter((statement) =>
      isRunChooser(statement.query)
    );
    expect(choosers.map((statement) => statement.params)).toEqual([
      ["wf_1", 500],
      ["wf_1", 500],
    ]);
    // Each batch: choose, lock schedule rows, lock runs, delete runs.
    const runStatements = queries.filter(
      (query) => !query.includes("workflow_execution_events")
    );
    const batch = [
      /^select "id" from "workflow_executions" where "workflow_executions"."workflow_id" = \$1 limit \$2$/,
      /from "workflow_execution_schedule" where .* order by "workflow_execution_schedule"."id" asc for update$/,
      /^select .* from "workflow_executions" where .* order by "workflow_executions"."id" asc for update$/,
      /^delete from "workflow_executions" where "workflow_executions"."id" in /,
    ];
    expect(runStatements).toHaveLength(batch.length * 2);
    runStatements.forEach((query, index) => {
      expect(query).toMatch(batch[index % batch.length] ?? /^$/);
    });
  });

  // The audit rows left once the runs are gone name no run, such as a
  // Refused Start's, and go by workflow, also in bounded batches.
  it("deletes the workflow's remaining audit rows after its runs, in a bounded batch", async () => {
    const { run, statements } = deleteHarness([0]);

    await run();

    const last = statements.at(-1);
    expect(last?.query).toMatch(/^delete from "workflow_execution_events"/);
    expect(last?.query).toContain('"workflow_id" = $1');
    expect(last?.params).toEqual(["wf_1", 500]);
  });

  it("names no cascading table", async () => {
    const { run, statements } = deleteHarness([500, 0]);

    await run();

    const queries = statements.map((statement) => statement.query).join("\n");
    expect(queries).not.toContain("workflow_execution_logs");
    expect(queries).not.toContain("workflow_wait_states");
  });
});
