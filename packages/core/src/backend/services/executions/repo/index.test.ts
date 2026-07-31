/**
 * What the locked start decides, read back through a driver that answers with
 * rows the test chose.
 *
 * The decision lives in a `WHERE` and in the order the statements go out, neither
 * of which a service test can see: it stubs the whole repo. `drizzle-orm/pg-proxy`
 * runs the query builder and hands each statement to a callback, so the statement
 * and the sequence are the assertion. The proxy driver has no transactions, hence
 * the `transaction` the harness supplies.
 */

import { drizzle } from "drizzle-orm/pg-proxy";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { RovaDatabase } from "#src/backend/lib/db/index";
import * as schema from "#src/backend/lib/db/schema";
import { Database } from "#src/backend/lib/effect/database";
import {
  type EntityStartOutcome,
  ExecutionRepo,
  ExecutionRepoLayer,
  UNSENT_RUN_GRACE_MS,
} from "#src/backend/services/executions/repo/index";

/** One row of the in-flight candidate query, in the order it selects columns. */
type InFlightRow = [id: string, enqueuedAt: Date | null, startedAt: Date];

const longAgo = new Date(Date.now() - UNSENT_RUN_GRACE_MS - 60_000);
const justNow = new Date();

function isInFlightQuery(query: string): boolean {
  return query.includes('"enqueued_at", "started_at"');
}

function isDeliveryLookup(query: string): boolean {
  return query.startsWith("select") && query.includes('"delivery_id" = $2');
}

function isInsert(query: string): boolean {
  return query.startsWith("insert");
}

function isUpdate(query: string): boolean {
  return query.startsWith("update");
}

function isLock(query: string): boolean {
  return query.includes("pg_advisory_xact_lock");
}

function harness(answers: {
  ownRow?: boolean;
  inFlight?: InFlightRow[];
  updated?: string[];
}) {
  const statements: { query: string; params: unknown[] }[] = [];

  const base = drizzle(
    async (query, params) => {
      statements.push({ query, params });

      if (isDeliveryLookup(query)) {
        return { rows: answers.ownRow ? [["exec_own"]] : [] };
      }
      if (isInFlightQuery(query)) {
        return { rows: answers.inFlight ?? [] };
      }
      if (query.startsWith("update")) {
        return { rows: (answers.updated ?? []).map((id) => [id]) };
      }
      if (query.startsWith("insert")) {
        return { rows: [["exec_new"]] };
      }
      return { rows: [] };
    },
    { schema }
  );

  const db: RovaDatabase = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async (body: (tx: unknown) => Promise<unknown>) => body(db);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as RovaDatabase;

  const databaseLayer = Layer.succeed(Database, {
    query: <A>(run: (db: RovaDatabase) => Promise<A>) =>
      Effect.promise(() => run(db)),
  } as Database["Service"]);

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
            startSource: "event",
            runMode: "live",
            correlationKey: "appt_1",
            input: {},
            deliveryId: deliveryId ?? undefined,
          },
          concurrency,
          entityValue: "appt_1",
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

  return { sent, sentAny, start };
}

describe("startForEntity", () => {
  // The caller is an Inngest step, so a retry re-runs this whole call. Without
  // the lookup the retry inserts a second row and sends under a second
  // idempotency key, and one arrival runs the graph twice.
  it("answers with the row this arrival already opened", async () => {
    const { sentAny, start } = harness({ ownRow: true });

    const outcome = await start("first-wins");

    expect(outcome.status).toBe("started");
    expect(sentAny(isInsert)).toBe(false);
    expect(sentAny(isInFlightQuery)).toBe(false);
  });

  // Two attempts at one arrival can reach the insert together under `unlimited`,
  // which takes no lock to serialize them.
  it("opens at most one row per arrival, held on the insert", async () => {
    const { sent, start } = harness({});

    await start("unlimited");

    expect(sent(isInsert)?.query).toContain(
      'on conflict ("workflow_id","delivery_id") do nothing'
    );
  });

  it("defers to a run the bus was told about", async () => {
    const { sentAny, start } = harness({
      inFlight: [["exec_live", justNow, justNow]],
    });

    const outcome = await start("first-wins");

    expect(outcome).toEqual({
      status: "refused",
      inFlightExecutionIds: ["exec_live"],
    });
    expect(sentAny(isInsert)).toBe(false);
  });

  // A crash between the committed row and the send leaves a row nothing will
  // ever finish, and first-wins would defer to it for the life of the entity.
  it("closes a run stuck before the bus and starts anyway", async () => {
    const { sent, start } = harness({
      inFlight: [["exec_stuck", null, longAgo]],
      updated: ["exec_stuck"],
    });

    const outcome = await start("first-wins");

    expect(outcome).toMatchObject({
      status: "started",
      reclaimedExecutionIds: ["exec_stuck"],
    });

    const update = sent(isUpdate);
    expect(update?.params).toContain("failed");
    // The run may have woken up and finished while the start was deciding.
    expect(update?.query).toContain('"status" in ($6, $7, $8)');
  });

  // The stamp goes on milliseconds after the commit, so an unstamped row within
  // the grace period is a start still in progress rather than a dead one.
  it("leaves an unstamped run alone until the grace period is up", async () => {
    const { start } = harness({
      inFlight: [["exec_starting", null, justNow]],
    });

    const outcome = await start("first-wins");

    expect(outcome).toEqual({
      status: "refused",
      inFlightExecutionIds: ["exec_starting"],
    });
  });

  it("defers to a live run rather than reclaiming the stuck one beside it", async () => {
    const { sentAny, start } = harness({
      inFlight: [
        ["exec_stuck", null, longAgo],
        ["exec_live", justNow, justNow],
      ],
    });

    const outcome = await start("first-wins");

    expect(outcome).toEqual({
      status: "refused",
      inFlightExecutionIds: ["exec_live"],
    });
    expect(sentAny(isUpdate)).toBe(false);
  });

  // Two reschedules arriving together otherwise both read an empty in-flight set
  // and both start. The two-key form keeps the workflow and the entity in
  // separate hashes, so no pair of values can join into another pair's key.
  it("serializes the decision per workflow and entity", async () => {
    const { sent, start } = harness({});

    await start("newest-wins");

    const lock = sent(isLock);
    expect(lock?.params).toEqual(["rova:entity:wf_1", "appt_1"]);
  });

  // Unlimited compares nothing, so a lock would only make concurrent starts of
  // one entity queue up behind each other for no decision.
  it("takes no lock where nothing is compared", async () => {
    const { sentAny, start } = harness({});

    await start("unlimited");

    expect(sentAny(isLock)).toBe(false);
  });

  // The four equalities are the whole scope of what this start may displace.
  // Without the run mode a test run supersedes the live run it was meant to sit
  // beside; without the correlation key one arrival supersedes every in-flight
  // run of the workflow.
  it("looks only at this workflow's in-flight runs for this entity and mode", async () => {
    const { sent, start } = harness({});

    await start("newest-wins");

    const candidates = sent(isInFlightQuery);
    expect(candidates?.query).toContain('"workflow_id" = ');
    expect(candidates?.query).toContain('"correlation_key" = ');
    expect(candidates?.query).toContain('"run_mode" = ');
    expect(candidates?.params.slice(0, 3)).toEqual(["wf_1", "appt_1", "live"]);
    expect(candidates?.params.slice(3)).toEqual([
      "pending",
      "running",
      "waiting",
    ]);
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
  const statements: { query: string; params: unknown[] }[] = [];

  const base = drizzle(
    async (query, params) => {
      statements.push({ query, params });
      return { rows: [] };
    },
    { schema }
  );

  const db: RovaDatabase = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async (body: (tx: unknown) => Promise<unknown>) => body(db);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as RovaDatabase;

  const databaseLayer = Layer.succeed(Database, {
    query: <A>(run: (db: RovaDatabase) => Promise<A>) =>
      Effect.promise(() => run(db)),
  } as Database["Service"]);

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
