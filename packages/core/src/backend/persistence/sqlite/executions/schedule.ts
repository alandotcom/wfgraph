/**
 * The schedule and step memo slice of the SQLite `ExecutionRepo`, and the
 * fencing a pass's writes stand on.
 *
 * SQLite has one writer: every write here runs inside one `BEGIN IMMEDIATE`
 * transaction, so a claim needs no `SKIP LOCKED` and a fence check needs no row
 * lock. The check and the write it guards still share one transaction, which
 * is what keeps a released or deleted schedule row from being written past.
 */

import { Effect } from "effect";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { sortBy } from "es-toolkit/array";
import type {
  DatabaseError,
  LeaseLost,
} from "#src/backend/lib/effect/database";
import type {
  OwnerFence,
  ParkWake,
} from "#src/backend/services/executions/repo/contracts";
import {
  decideRelease,
  ownershipLost,
} from "#src/backend/services/executions/repo/fencing";
import {
  claimedExecution,
  type PassWrites,
  type ScheduleRepoMethods,
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

/** The wake a claim writes onto a park whose deadline passed. */
const TIMEOUT_WAKE: ParkWake = { kind: "timeout" };

function holdsLease(database: SqliteExecutor, fence: OwnerFence) {
  return database
    .select({ executionId: workflowExecutionSchedule.executionId })
    .from(workflowExecutionSchedule)
    .where(
      and(
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
 * Execution's schedule row is still leased under the pass's token. Nothing
 * runs when it is not, which answers `LeaseLost`.
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
 * Closes what Executions whose terminal record this transaction wrote still
 * hold open, as the PostgreSQL backend's `settleEndedExecutions` does: open
 * wait rows are cancelled, and the schedule row and step memo are deleted. The
 * log rows stay.
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
          inArray(workflowWaitStates.status, ["waiting", "resuming"])
        )
      );
    yield* database
      .delete(workflowExecutionSteps)
      .where(inArray(workflowExecutionSteps.executionId, ids));
    yield* database
      .delete(workflowExecutionSchedule)
      .where(inArray(workflowExecutionSchedule.executionId, ids));
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

export function makeSqliteScheduleMethods(
  store: SqliteDatabase
): ScheduleRepoMethods {
  return {
    scheduleExecution: (input) =>
      store.write((database) =>
        database
          .insert(workflowExecutionSchedule)
          .values({
            executionId: input.executionId,
            kind: input.kind,
            state: "queued",
            wakeAt: input.wakeAt.getTime(),
          })
          .onConflictDoNothing()
          .returning({ executionId: workflowExecutionSchedule.executionId })
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
      store.write((database) =>
        Effect.gen(function* () {
          const now = input.now.getTime();
          const due = database
            .select({ executionId: workflowExecutionSchedule.executionId })
            .from(workflowExecutionSchedule)
            .where(
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
            .orderBy(
              asc(workflowExecutionSchedule.wakeAt),
              asc(workflowExecutionSchedule.executionId)
            )
            .limit(input.limit);
          const claimed = yield* database
            .update(workflowExecutionSchedule)
            .set({
              state: "leased",
              ownerToken: sql`lower(hex(randomblob(16)))`,
              leaseExpiresAt: now + input.leaseMs,
              workerId: input.workerId,
              // Only an expired lease counts an attempt here: the pass it cut
              // short is the failure. A row queued by a wake spends nothing.
              attempt: sql`case when ${workflowExecutionSchedule.state} = 'leased' then ${workflowExecutionSchedule.attempt} + 1 else ${workflowExecutionSchedule.attempt} end`,
            })
            .where(inArray(workflowExecutionSchedule.executionId, due))
            .returning();

          const claimedIds = claimed.map((row) => row.executionId);
          if (claimedIds.length > 0) {
            yield* database
              .update(workflowWaitStates)
              .set({ wake: encodeJson(TIMEOUT_WAKE), status: "resuming" })
              .where(
                and(
                  inArray(workflowWaitStates.executionId, claimedIds),
                  eq(workflowWaitStates.status, "waiting"),
                  lte(workflowWaitStates.waitUntil, now)
                )
              );
          }

          return sortBy(claimed.map(sqliteExecutionSchedule), [
            (row) => row.wakeAt.getTime(),
            (row) => row.executionId,
          ]).map(claimedExecution);
        })
      ),

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
          const requeued = yield* database
            .update(workflowExecutionSchedule)
            .set({ state: "queued", wakeAt: input.now.getTime() })
            .where(
              and(
                eq(workflowExecutionSchedule.executionId, input.executionId),
                eq(workflowExecutionSchedule.state, "waiting")
              )
            )
            .returning({ executionId: workflowExecutionSchedule.executionId });
          return {
            resolved: resolved.length > 0,
            requeued: requeued.length > 0,
          };
        })
      ),

    listStepMemo: (executionId) =>
      store.read((database) =>
        database
          .select({
            stepId: workflowExecutionSteps.stepId,
            attempt: workflowExecutionSteps.attempt,
            value: workflowExecutionSteps.value,
          })
          .from(workflowExecutionSteps)
          .where(eq(workflowExecutionSteps.executionId, executionId))
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                stepId: row.stepId,
                attempt: row.attempt,
                value: optionalJsonValue(row.value, "step value"),
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
  const { executionId } = fence;
  const ofThisRun = eq(workflowExecutionSchedule.executionId, executionId);
  return {
    renewLease: (input) =>
      writeFenced(store, fence, (database) =>
        database
          .update(workflowExecutionSchedule)
          .set({ leaseExpiresAt: input.leaseExpiresAt.getTime() })
          .where(ofThisRun)
      ).pipe(Effect.asVoid),

    writeStepMemo: (input) =>
      writeFenced(store, fence, (database) =>
        Effect.gen(function* () {
          yield* database
            .insert(workflowExecutionSteps)
            .values({
              executionId,
              stepId: input.stepId,
              attempt: input.attempt,
              value: encodeJson(input.value),
              createdAt: Date.now(),
            })
            .onConflictDoNothing();
          if (input.leaseExpiresAt !== undefined) {
            yield* database
              .update(workflowExecutionSchedule)
              .set({ leaseExpiresAt: input.leaseExpiresAt.getTime() })
              .where(ofThisRun);
          }
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
            .where(ofThisRun)
            .get();
          const attempt = schedule?.attempt ?? 0;
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
                inArray(workflowWaitStates.status, ["waiting", "resuming"])
              )
            );

          if (input.outcome.kind === "retries_spent") {
            yield* database
              .insert(workflowExecutionSteps)
              .values({
                executionId,
                stepId: input.outcome.stepId,
                attempt,
                value: encodeJson(input.outcome.failure),
                createdAt: Date.now(),
              })
              .onConflictDoNothing();
          }

          const released = decideRelease({
            outcome: input.outcome,
            attempt,
            now: input.now,
            parks: parks.map((park) => ({
              status: park.status === "waiting" ? "waiting" : "resuming",
              waitUntil:
                park.waitUntil === null ? null : new Date(park.waitUntil),
              woken: park.wake !== null,
            })),
          });
          yield* database
            .update(workflowExecutionSchedule)
            .set({
              state: released.state,
              wakeAt: released.wakeAt.getTime(),
              attempt: released.attempt,
              lastError: released.lastError,
              leaseExpiresAt: null,
              ownerToken: null,
              workerId: null,
            })
            .where(ofThisRun);
          return {
            state: released.state,
            wakeAt: released.wakeAt,
            attempt: released.attempt,
          };
        })
      ),
  };
}
