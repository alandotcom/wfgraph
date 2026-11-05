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
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
import type {
  DatabaseError,
  LeaseLost,
} from "#src/backend/lib/effect/database";
import type {
  CountedStepFailure,
  OwnerFence,
  ParkWake,
} from "#src/backend/services/executions/repo/contracts";
import { ownershipLost } from "#src/backend/services/executions/repo/fencing";
import {
  claimAttempt,
  countStepFailure,
  decideRelease,
  LEASE_EXPIRED_ERROR,
  OPEN_PARK_STATUSES,
  sweptStepFailures,
  TIMEOUT_WAKE,
} from "#src/backend/services/executions/repo/release-policy";
import {
  claimedExecutions,
  type PassWrites,
  type ScheduleRepoMethods,
  stepMemoOf,
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

function holdsLease(database: SqliteExecutor, fence: OwnerFence) {
  return database
    .select({ id: workflowExecutionSchedule.id })
    .from(workflowExecutionSchedule)
    .where(
      and(
        eq(workflowExecutionSchedule.id, fence.scheduleId),
        eq(workflowExecutionSchedule.executionId, fence.executionId),
        eq(workflowExecutionSchedule.state, "leased"),
        eq(workflowExecutionSchedule.ownerToken, fence.ownerToken)
      )
    )
    .get()
    .pipe(Effect.map((row) => row !== undefined));
}

type Owned<A> = { owned: true; value: A } | { owned: false };

/**
 * Runs one write of a pass in the write transaction, after checking that the
 * pass's schedule row is still leased under its token and still names its
 * run. Nothing runs when it is not, which answers `LeaseLost`.
 */
export function writeFenced<A>(
  store: SqliteDatabase,
  fence: OwnerFence,
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
function settleEndedExecutions(
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
          inArray(workflowWaitStates.status, [...OPEN_PARK_STATUSES])
        )
      );
    yield* database
      .delete(workflowExecutionSchedule)
      .where(inArray(workflowExecutionSchedule.executionId, ids));
  });
}

/**
 * Runs a write that may make runs terminal inside the caller's write
 * transaction. `write` reports which runs it ended, and their open wait rows,
 * schedule rows and step memos are settled before the transaction commits.
 */
export function endExecutions<A, E>(
  database: SqliteExecutor,
  write: Effect.Effect<{ result: A; ended: readonly string[] }, E>
): Effect.Effect<A, unknown> {
  return Effect.gen(function* () {
    const { result, ended } = yield* write;
    yield* settleEndedExecutions(database, ended);
    return result;
  });
}

/**
 * Resolves every park of one run still `waiting` with `wake`, as the
 * PostgreSQL backend's `resolveOpenParks` does. It runs inside the caller's
 * write transaction, which already holds the one writer.
 */
export function resolveOpenParks(
  database: SqliteExecutor,
  executionId: string,
  wake: ParkWake
) {
  return database
    .update(workflowWaitStates)
    .set({ wake: encodeJson(wake), status: "resuming" })
    .where(
      and(
        eq(workflowWaitStates.executionId, executionId),
        eq(workflowWaitStates.status, "waiting")
      )
    );
}

/**
 * Moves one run's schedule row from `waiting` to `queued` at `now`, answering
 * whether it moved, as the PostgreSQL backend's `requeueWaitingRun` does. A
 * `leased` row is left for its release, which reads the wakes the caller's
 * transaction wrote.
 */
export function requeueWaitingRun(
  database: SqliteExecutor,
  executionId: string,
  now: Date
) {
  return database
    .update(workflowExecutionSchedule)
    .set({ state: "queued", wakeAt: now.getTime() })
    .where(
      and(
        eq(workflowExecutionSchedule.executionId, executionId),
        eq(workflowExecutionSchedule.state, "waiting")
      )
    )
    .returning({ id: workflowExecutionSchedule.id })
    .pipe(Effect.map((requeued) => requeued.length > 0));
}

const memoColumns = {
  stepId: workflowExecutionSteps.stepId,
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
 * decides, answering the row it wrote.
 */
function countFailureOnStep(
  database: SqliteExecutor,
  input: { scheduleId: string; stepId: string; error: string }
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
      input.error
    );
    if (counted === null) return null;
    yield* database
      .insert(workflowExecutionSteps)
      .values({
        scheduleId: input.scheduleId,
        stepId: input.stepId,
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
    scheduleExecution: (input) =>
      store.write((database) =>
        database
          .insert(workflowExecutionSchedule)
          .values({
            id: generateId(),
            kind: input.kind,
            executionId: input.executionId,
            state: "queued",
            wakeAt: input.wakeAt.getTime(),
          })
          .onConflictDoNothing()
          .returning({ id: workflowExecutionSchedule.id })
          .pipe(Effect.map((rows) => rows.length > 0))
      ),

    findSchedule: (executionId) =>
      store.read((database) =>
        database
          .select()
          .from(workflowExecutionSchedule)
          .where(eq(workflowExecutionSchedule.executionId, executionId))
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
            const due = yield* database
              .select({
                id: workflowExecutionSchedule.id,
                state: workflowExecutionSchedule.state,
                runningStepId: workflowExecutionSchedule.runningStepId,
              })
              .from(workflowExecutionSchedule)
              .where(
                and(
                  eq(workflowExecutionSchedule.kind, "run"),
                  or(
                    and(
                      inArray(workflowExecutionSchedule.state, [
                        "queued",
                        "waiting",
                      ]),
                      lte(workflowExecutionSchedule.wakeAt, now)
                    ),
                    and(
                      eq(workflowExecutionSchedule.state, "leased"),
                      lte(workflowExecutionSchedule.leaseExpiresAt, now)
                    )
                  )
                )
              )
              .orderBy(
                asc(workflowExecutionSchedule.wakeAt),
                asc(workflowExecutionSchedule.id)
              )
              .limit(input.limit);
            if (due.length === 0) return [];

            const claimed = yield* database
              .update(workflowExecutionSchedule)
              .set({
                state: "leased",
                ownerToken: sql`lower(hex(randomblob(16)))`,
                leaseExpiresAt: now + input.leaseMs,
                workerId: input.workerId,
                attempt: claimAttempt(workflowExecutionSchedule),
                runningStepId: null,
              })
              .where(
                inArray(
                  workflowExecutionSchedule.id,
                  due.map((row) => row.id)
                )
              )
              .returning();

            for (const swept of sweptStepFailures(due)) {
              yield* countFailureOnStep(database, {
                ...swept,
                error: LEASE_EXPIRED_ERROR,
              });
            }
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
                    eq(workflowWaitStates.status, "waiting"),
                    lte(workflowWaitStates.waitUntil, now)
                  )
                );
            }
            return claimed.map(sqliteExecutionSchedule);
          })
        )
        .pipe(Effect.flatMap(claimedExecutions)),

    resolvePark: (input) =>
      store.write((database) =>
        Effect.gen(function* () {
          // One writer holds the database for the whole transaction, so the
          // release cannot read the wait rows between these two statements.
          const resolved = yield* database
            .update(workflowWaitStates)
            .set({ wake: encodeJson(input.wake), status: "resuming" })
            .where(
              and(
                eq(workflowWaitStates.id, input.waitStateId),
                eq(workflowWaitStates.executionId, input.executionId),
                eq(workflowWaitStates.status, "waiting")
              )
            )
            .returning({ id: workflowWaitStates.id });
          if (resolved.length === 0) {
            return { resolved: false, requeued: false };
          }
          return {
            resolved: true,
            requeued: yield* requeueWaitingRun(
              database,
              input.executionId,
              input.now
            ),
          };
        })
      ),

    revokeLease: (input) =>
      store.write((database) =>
        database
          .update(workflowExecutionSchedule)
          .set({
            state: "queued",
            wakeAt: input.now.getTime(),
            ownerToken: null,
            leaseExpiresAt: null,
            workerId: null,
            runningStepId: null,
          })
          .where(eq(workflowExecutionSchedule.executionId, input.executionId))
          .returning({ id: workflowExecutionSchedule.id })
          .pipe(Effect.map((rows) => rows.length > 0))
      ),

    listStepMemo: (executionId) =>
      store.read((database) =>
        database
          .select(memoColumns)
          .from(workflowExecutionSteps)
          .innerJoin(
            workflowExecutionSchedule,
            eq(workflowExecutionSchedule.id, workflowExecutionSteps.scheduleId)
          )
          .where(eq(workflowExecutionSchedule.executionId, executionId))
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                stepId: row.stepId,
                ...sqliteStepMemo(row),
              }))
            )
          )
      ),
  };
}

/** Builds the writes only a pass makes, fenced on `fence`. */
export function makeSqlitePassWrites(
  store: SqliteDatabase,
  fence: OwnerFence
): PassWrites {
  const { scheduleId, executionId } = fence;
  const thisSchedule = eq(workflowExecutionSchedule.id, scheduleId);
  return {
    renewLease: (input) =>
      writeFenced(store, fence, (database) =>
        database
          .update(workflowExecutionSchedule)
          .set({
            leaseExpiresAt: input.leaseExpiresAt.getTime(),
            runningStepId: input.runningStepId,
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
              runningStepId: sql`nullif(${workflowExecutionSchedule.runningStepId}, ${input.stepId})`,
            })
            .where(thisSchedule);
        })
      ),

    recordParkStep: (input) =>
      writeFenced(store, fence, (database) =>
        database
          .update(workflowWaitStates)
          .set({ parkStepId: input.parkStepId })
          .where(
            and(
              eq(workflowWaitStates.id, input.waitStateId),
              eq(workflowWaitStates.executionId, executionId)
            )
          )
      ).pipe(Effect.asVoid),

    releasePass: (input) =>
      writeFenced(store, fence, (database) =>
        Effect.gen(function* () {
          const schedule = yield* database
            .select({ attempt: workflowExecutionSchedule.attempt })
            .from(workflowExecutionSchedule)
            .where(thisSchedule)
            .get();
          const parks = yield* database
            .select({
              status: workflowWaitStates.status,
              waitUntil: workflowWaitStates.waitUntil,
              wake: workflowWaitStates.wake,
            })
            .from(workflowWaitStates)
            .where(
              and(
                eq(workflowWaitStates.executionId, executionId),
                inArray(workflowWaitStates.status, [...OPEN_PARK_STATUSES])
              )
            );
          const { outcome } = input;
          const countedStep =
            outcome.kind === "step_failed"
              ? yield* countFailureOnStep(database, {
                  scheduleId,
                  stepId: outcome.stepId,
                  error: outcome.error,
                })
              : null;

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
              runningStepId: null,
              leaseExpiresAt: null,
              ownerToken: null,
              workerId: null,
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
