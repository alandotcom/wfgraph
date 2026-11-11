/**
 * The schedule and step memo slice of the SQLite `ExecutionRepo`, and the
 * fencing a pass's writes stand on. `release-policy.ts` makes the decisions;
 * this file runs the statements they call for.
 *
 * SQLite has one writer: every write here runs inside one `BEGIN IMMEDIATE`
 * transaction, so a claim needs no `SKIP LOCKED` and a fence check needs no row
 * lock. The check and the write it guards still share one transaction, which
 * is what keeps a released or deleted schedule row from being written past.
 */

import { Effect } from "effect";
import { and, asc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
import type {
  DatabaseError,
  LeaseLost,
} from "#src/backend/lib/effect/database";
import type {
  CountedStepFailure,
  ParkWake,
  PassFence,
  RunFence,
  ScheduleRowKey,
} from "#src/backend/services/executions/repo/contracts";
import { ownershipLost } from "#src/backend/services/executions/repo/fencing";
import {
  claimAttempt,
  CLEARED_LEASE,
  claimedSchedules,
  countStepFailure,
  decideRelease,
  dueSchedule,
  type DueSchedule,
  leasedUnderFence,
  openPark,
  overduePark,
  parkResolution,
  requeuedByWake,
  requeuedWakeAt,
  runningAfterMemo,
  runningOnRenew,
  stepFailureOf,
  type StepFailure,
  stepMemoOf,
  sweptStepFailures,
  TIMEOUT_WAKE,
} from "#src/backend/services/executions/repo/release-policy";
import type {
  ParkWrites,
  PassWrites,
  ScheduleRepoMethods,
} from "#src/backend/services/executions/repo/schedule";
import type {
  SqliteDatabase,
  SqliteExecutor,
} from "#src/backend/persistence/sqlite/database";
import { encodeJson } from "#src/backend/persistence/sqlite/database";
import {
  workflowExecutionSchedule,
  workflowExecutionSteps,
  workflowWaitStates,
} from "#src/backend/persistence/sqlite/schema";
import {
  optionalJsonValue,
  sqliteExecutionSchedule,
} from "#src/backend/persistence/sqlite/executions/rows";

function holdsLease(database: SqliteExecutor, fence: PassFence) {
  return database
    .select({ id: workflowExecutionSchedule.id })
    .from(workflowExecutionSchedule)
    .where(leasedUnderFence(workflowExecutionSchedule, fence))
    .get()
    .pipe(Effect.map((row) => row !== undefined));
}

type Owned<A> = { owned: true; value: A } | { owned: false };

/**
 * Runs one write of a pass in the write transaction, after checking that the
 * pass's schedule row is still leased under its token and still names the
 * fence's run or inbox row (`leasedUnderFence`). Nothing runs when it is not,
 * which answers `LeaseLost`.
 */
export function writeFenced<A>(
  store: SqliteDatabase,
  fence: PassFence,
  write: (database: SqliteExecutor) => Effect.Effect<A, unknown>
): Effect.Effect<A, DatabaseError | LeaseLost> {
  return store
    .write((database) =>
      holdsLease(database, fence).pipe(
        Effect.flatMap((owned): Effect.Effect<Owned<A>, unknown> =>
          owned
            ? write(database).pipe(
                Effect.map((value) => ({ owned: true, value }))
              )
            : Effect.succeed({ owned: false })
        )
      )
    )
    .pipe(
      Effect.flatMap((result) =>
        result.owned
          ? Effect.succeed(result.value)
          : Effect.fail(ownershipLost())
      )
    );
}

/**
 * Closes what runs whose terminal record this transaction wrote still hold
 * open, as `OPEN_PARK_STATUSES` describes: their open wait rows are cancelled
 * and their schedule rows are deleted, which deletes the step memo by cascade.
 */
export function settleEndedExecutions(
  database: SqliteExecutor,
  executionIds: readonly string[]
) {
  if (executionIds.length === 0) return Effect.void;
  const ids = [...executionIds];
  return Effect.gen(function* () {
    yield* database
      .update(workflowWaitStates)
      .set({ status: "cancelled", cancelledAt: Date.now() })
      .where(
        and(
          inArray(workflowWaitStates.executionId, ids),
          openPark(workflowWaitStates)
        )
      );
    yield* database
      .delete(workflowExecutionSchedule)
      .where(inArray(workflowExecutionSchedule.executionId, ids));
  });
}

/**
 * Gives a run its schedule row, `queued` and due at `wakeAt`, inside the write
 * transaction that inserts the run's execution row (`startForEntity`).
 */
export function insertRunSchedule(
  database: SqliteExecutor,
  input: { executionId: string; wakeAt: Date }
) {
  return database.insert(workflowExecutionSchedule).values({
    id: generateId(),
    kind: "run",
    executionId: input.executionId,
    state: "queued",
    wakeAt: input.wakeAt.getTime(),
  });
}

/**
 * Resolves every park still `waiting` of the runs named with `wake`,
 * answering the run of each park it resolved, as the PostgreSQL backend's
 * `resolveOpenParks` does. It runs inside the caller's write transaction,
 * which already holds the one writer.
 */
export function resolveOpenParks(
  database: SqliteExecutor,
  executionIds: readonly string[],
  wake: ParkWake
): Effect.Effect<string[], unknown> {
  if (executionIds.length === 0) return Effect.succeed([]);
  return database
    .update(workflowWaitStates)
    .set({ wake: encodeJson(wake), status: "resuming" })
    .where(
      and(
        inArray(workflowWaitStates.executionId, [...executionIds]),
        eq(workflowWaitStates.status, "waiting")
      )
    )
    .returning({ executionId: workflowWaitStates.executionId })
    .pipe(Effect.map((resolved) => resolved.map((row) => row.executionId)));
}

/**
 * Runs a producer's write inside the caller's write transaction, then makes
 * due the schedule rows of the runs it woke, as the PostgreSQL backend's
 * `wakeExecutions` does. The transaction holds the one writer from its first
 * statement, so no release reads the wait rows between the write and the
 * re-queue, and nothing needs locking first. Answers the write's result and
 * the schedule rows it made due.
 */
export function wakeExecutions<A, E>(
  database: SqliteExecutor,
  now: Date,
  write: Effect.Effect<{ result: A; woken: readonly string[] }, E>
): Effect.Effect<{ result: A; due: DueSchedule[] }, unknown> {
  return Effect.gen(function* () {
    const { result, woken } = yield* write;
    if (woken.length === 0) return { result, due: [] };
    const due = yield* database
      .update(workflowExecutionSchedule)
      .set({
        state: "queued",
        wakeAt: requeuedWakeAt(workflowExecutionSchedule, now.getTime()),
      })
      .where(
        and(
          inArray(workflowExecutionSchedule.executionId, [...woken]),
          requeuedByWake(workflowExecutionSchedule, now.getTime())
        )
      )
      .returning({
        scheduleId: workflowExecutionSchedule.id,
        executionId: workflowExecutionSchedule.executionId,
      });
    return { result, due };
  });
}

/** The schedule row a `ScheduleRowKey` names. */
function scheduleRow(key: ScheduleRowKey): SQL {
  if ("scheduleId" in key) {
    return eq(workflowExecutionSchedule.id, key.scheduleId);
  }
  if ("executionId" in key) {
    return eq(workflowExecutionSchedule.executionId, key.executionId);
  }
  return eq(workflowExecutionSchedule.inboxId, key.inboxId);
}

const memoColumns = {
  stepId: workflowExecutionSteps.stepId,
  nodeId: workflowExecutionSteps.nodeId,
  status: workflowExecutionSteps.status,
  failures: workflowExecutionSteps.failures,
  value: workflowExecutionSteps.value,
  error: workflowExecutionSteps.error,
};

/** A memo row read back from SQLite's text columns. */
function sqliteStepMemo(row: {
  status: string;
  failures: number;
  value: string | null;
  error: string | null;
}) {
  return stepMemoOf({
    status: row.status,
    failures: row.failures,
    value: optionalJsonValue(row.value, "step value"),
    error: row.error,
  });
}

/**
 * Counts one failure against a step's memo row, as `countStepFailure`
 * decides, answering the row it wrote. A row this creates carries the step's
 * node id.
 */
function countFailureOnStep(
  database: SqliteExecutor,
  input: StepFailure & { scheduleId: string }
): Effect.Effect<CountedStepFailure | null, unknown> {
  return Effect.gen(function* () {
    const row = yield* database
      .select(memoColumns)
      .from(workflowExecutionSteps)
      .where(
        and(
          eq(workflowExecutionSteps.scheduleId, input.scheduleId),
          eq(workflowExecutionSteps.stepId, input.stepId)
        )
      )
      .get();
    const counted = countStepFailure(
      row === undefined ? undefined : sqliteStepMemo(row),
      input
    );
    if (counted === null) return null;
    yield* database
      .insert(workflowExecutionSteps)
      .values({
        scheduleId: input.scheduleId,
        stepId: input.stepId,
        nodeId: input.nodeId,
        status: counted.status,
        failures: counted.failures,
        error: counted.error,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [
          workflowExecutionSteps.scheduleId,
          workflowExecutionSteps.stepId,
        ],
        set: {
          status: counted.status,
          failures: counted.failures,
          error: counted.error,
        },
      });
    return counted;
  });
}

export function makeSqliteScheduleMethods(
  store: SqliteDatabase
): ScheduleRepoMethods {
  return {
    findSchedule: (key) =>
      store.read((database) =>
        database
          .select()
          .from(workflowExecutionSchedule)
          .where(scheduleRow(key))
          .get()
          .pipe(
            Effect.map((row) => (row ? sqliteExecutionSchedule(row) : null))
          )
      ),

    claimDue: (input) =>
      store
        .write((database) =>
          Effect.gen(function* () {
            const now = input.now.getTime();
            const lanes = input.lanes.filter((lane) => lane.limit > 0);
            if (lanes.length === 0) return [];
            // One select reads every lane, each lane a subquery limited to
            // its own rows.
            const due = yield* database
              .select({
                id: workflowExecutionSchedule.id,
                state: workflowExecutionSchedule.state,
                runningStepId: workflowExecutionSchedule.runningStepId,
                runningNodeId: workflowExecutionSchedule.runningNodeId,
              })
              .from(workflowExecutionSchedule)
              .where(
                or(
                  ...lanes.map((lane) =>
                    inArray(
                      workflowExecutionSchedule.id,
                      database
                        .select({ id: workflowExecutionSchedule.id })
                        .from(workflowExecutionSchedule)
                        .where(
                          dueSchedule(workflowExecutionSchedule, {
                            kind: lane.kind,
                            now,
                          })
                        )
                        .orderBy(
                          asc(workflowExecutionSchedule.wakeAt),
                          asc(workflowExecutionSchedule.id)
                        )
                        .limit(lane.limit)
                    )
                  )
                )
              );
            if (due.length === 0) return [];

            // A swept step whose memo row already settled counts against the
            // run instead, so no expired lease goes uncounted.
            const uncounted: string[] = [];
            for (const swept of sweptStepFailures(due)) {
              const counted = yield* countFailureOnStep(database, swept);
              if (counted === null) uncounted.push(swept.scheduleId);
            }

            const claimed = yield* database
              .update(workflowExecutionSchedule)
              .set({
                state: "leased",
                ownerToken: sql`lower(hex(randomblob(16)))`,
                leaseExpiresAt: now + input.leaseMs,
                workerId: input.workerId,
                attempt: claimAttempt(workflowExecutionSchedule, uncounted),
                runningStepId: null,
                runningNodeId: null,
              })
              .where(
                inArray(
                  workflowExecutionSchedule.id,
                  due.map((row) => row.id)
                )
              )
              .returning();

            const claimedRuns = claimed.flatMap((row) =>
              row.executionId === null ? [] : [row.executionId]
            );
            if (claimedRuns.length > 0) {
              yield* database
                .update(workflowWaitStates)
                .set({ wake: encodeJson(TIMEOUT_WAKE), status: "resuming" })
                .where(
                  and(
                    inArray(workflowWaitStates.executionId, claimedRuns),
                    overduePark(workflowWaitStates, now)
                  )
                );
            }
            return claimed.map(sqliteExecutionSchedule);
          })
        )
        .pipe(Effect.flatMap(claimedSchedules)),

    wakePark: (input) =>
      store
        .write((database) =>
          wakeExecutions(
            database,
            input.now,
            database
              .update(workflowWaitStates)
              .set({ wake: encodeJson(input.wake), status: "resuming" })
              .where(
                and(
                  eq(workflowWaitStates.id, input.waitStateId),
                  eq(workflowWaitStates.executionId, input.executionId),
                  eq(workflowWaitStates.status, "waiting")
                )
              )
              .returning({ executionId: workflowWaitStates.executionId })
              .pipe(
                Effect.map((resolved) => ({
                  result: resolved.length > 0,
                  woken: resolved.map((row) => row.executionId),
                }))
              )
          )
        )
        .pipe(Effect.map(parkResolution)),

    listStepMemo: (key) =>
      store.read((database) =>
        database
          .select(memoColumns)
          .from(workflowExecutionSteps)
          .innerJoin(
            workflowExecutionSchedule,
            eq(workflowExecutionSchedule.id, workflowExecutionSteps.scheduleId)
          )
          .where(scheduleRow(key))
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                stepId: row.stepId,
                nodeId: row.nodeId,
                ...sqliteStepMemo(row),
              }))
            )
          )
      ),
  };
}

/** Builds the writes every pass makes, fenced on `fence`. */
export function makeSqlitePassWrites(
  store: SqliteDatabase,
  fence: PassFence
): PassWrites {
  const { scheduleId } = fence;
  const thisSchedule = eq(workflowExecutionSchedule.id, scheduleId);
  return {
    renewLease: (input) =>
      writeFenced(store, fence, (database) =>
        database
          .update(workflowExecutionSchedule)
          .set({
            leaseExpiresAt: input.leaseExpiresAt.getTime(),
            ...runningOnRenew(
              {
                table: workflowExecutionSteps,
                scheduleId: workflowExecutionSteps.scheduleId,
                stepId: workflowExecutionSteps.stepId,
                status: workflowExecutionSteps.status,
              },
              scheduleId,
              input.runningStepId === null
                ? null
                : { stepId: input.runningStepId, nodeId: input.runningNodeId }
            ),
          })
          .where(thisSchedule)
      ).pipe(Effect.asVoid),

    writeStepMemo: (input) =>
      writeFenced(store, fence, (database) =>
        Effect.gen(function* () {
          yield* database
            .insert(workflowExecutionSteps)
            .values({
              scheduleId,
              stepId: input.stepId,
              nodeId: input.nodeId,
              status: "succeeded",
              value: encodeJson(input.value),
              createdAt: Date.now(),
            })
            .onConflictDoUpdate({
              target: [
                workflowExecutionSteps.scheduleId,
                workflowExecutionSteps.stepId,
              ],
              set: {
                status: "succeeded",
                value: sql`excluded.value`,
                error: null,
              },
              setWhere: eq(workflowExecutionSteps.status, "failing"),
            });
          yield* database
            .update(workflowExecutionSchedule)
            .set({
              leaseExpiresAt: input.leaseExpiresAt.getTime(),
              ...runningAfterMemo(workflowExecutionSchedule, input.stepId),
            })
            .where(thisSchedule);
        })
      ),

    releasePass: (input) =>
      writeFenced(store, fence, (database) =>
        Effect.gen(function* () {
          const schedule = yield* database
            .select({
              attempt: workflowExecutionSchedule.attempt,
              executionId: workflowExecutionSchedule.executionId,
            })
            .from(workflowExecutionSchedule)
            .where(thisSchedule)
            .get();
          const executionId = schedule?.executionId ?? null;
          const parks =
            executionId === null
              ? []
              : yield* database
                  .select({
                    status: workflowWaitStates.status,
                    waitUntil: workflowWaitStates.waitUntil,
                    wake: workflowWaitStates.wake,
                  })
                  .from(workflowWaitStates)
                  .where(
                    and(
                      eq(workflowWaitStates.executionId, executionId),
                      openPark(workflowWaitStates)
                    )
                  );
          const { outcome } = input;
          const stepFailure = stepFailureOf(outcome);
          const countedStep =
            stepFailure === null
              ? null
              : yield* countFailureOnStep(database, {
                  scheduleId,
                  ...stepFailure,
                });

          const released = decideRelease({
            outcome,
            attempt: schedule?.attempt ?? 0,
            now: input.now,
            parks: parks.map((park) => ({
              status: park.status === "waiting" ? "waiting" : "resuming",
              waitUntil:
                park.waitUntil === null ? null : new Date(park.waitUntil),
              woken: park.wake !== null,
            })),
            countedStep,
          });
          yield* database
            .update(workflowExecutionSchedule)
            .set({
              state: released.state,
              wakeAt: released.wakeAt.getTime(),
              attempt: released.attempt,
              lastError: released.lastError,
              ...CLEARED_LEASE,
            })
            .where(thisSchedule);
          return {
            schedule: {
              state: released.state,
              wakeAt: released.wakeAt,
              attempt: released.attempt,
            },
            countedStep,
          };
        })
      ),

    dropSchedule: () =>
      writeFenced(store, fence, (database) =>
        database.delete(workflowExecutionSchedule).where(thisSchedule)
      ).pipe(Effect.asVoid),
  };
}

/**
 * Builds the write a pass over a `run` row makes when a Wait parks. The fence
 * holds the schedule row to the fence's Execution, so the wait row is held to
 * the same run.
 */
export function makeSqliteParkWrites(
  store: SqliteDatabase,
  fence: RunFence
): ParkWrites {
  return {
    recordParkStep: (input) =>
      writeFenced(store, fence, (database) =>
        database
          .update(workflowWaitStates)
          .set({ parkStepId: input.parkStepId })
          .where(
            and(
              eq(workflowWaitStates.id, input.waitStateId),
              eq(workflowWaitStates.executionId, fence.executionId)
            )
          )
      ).pipe(Effect.asVoid),
  };
}
