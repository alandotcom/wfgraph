/**
 * The `workflow_execution_schedule` and `workflow_execution_steps` slice of
 * `ExecutionRepo`, which the database executor runs on, and the PostgreSQL
 * locking a fenced write stands on.
 *
 * Lock order: every transaction here, and every fenced or terminal write in the
 * sibling slices, takes the Execution's schedule row before its execution row
 * and its wait rows. The producer and the release both lock the schedule row
 * first, so a wake either commits before a release reads the wait rows or finds
 * the row `waiting` after the release commits.
 */

import { and, asc, eq, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  type ExecutionScheduleKind,
  type ParkWake,
  workflowExecutionSchedule,
  workflowExecutionSteps,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type {
  WfGraphDatabase,
  WfGraphTransaction,
} from "#src/backend/lib/db/index";
import {
  type Database,
  type DatabaseError,
  serializableTransaction,
} from "#src/backend/lib/effect/database";
import type { Conflict } from "#src/backend/lib/effect/failures";
import type {
  ClaimedExecution,
  ExecutionSchedule,
  OwnerFence,
  ParkResolution,
  PassOutcome,
  ReleasedSchedule,
  StepMemoEntry,
} from "#src/backend/services/executions/repo/contracts";
import {
  decideRelease,
  ownershipLost,
} from "#src/backend/services/executions/repo/fencing";
import type { JsonValue } from "@wfgraph/shared/types/json";

type Executor = WfGraphDatabase | WfGraphTransaction;

/** How strongly a fenced write holds the schedule row it stands on. */
export type LeaseLock = "share" | "update";

/** The wake a claim writes onto a park whose deadline passed. */
const TIMEOUT_WAKE: ParkWake = { kind: "timeout" };

/**
 * Takes the Execution's schedule row when it is still leased under the fence's
 * token, answering whether it was.
 *
 * `share` lets the pass's concurrent writes stand on the row together while a
 * claim, a release, a producer or a terminal write waits for them. `update` is
 * for a write that changes or deletes the row itself.
 */
async function holdsLease(
  tx: Executor,
  fence: OwnerFence,
  lock: LeaseLock
): Promise<boolean> {
  const [row] = await tx
    .select({ executionId: workflowExecutionSchedule.executionId })
    .from(workflowExecutionSchedule)
    .where(
      and(
        eq(workflowExecutionSchedule.executionId, fence.executionId),
        eq(workflowExecutionSchedule.state, "leased"),
        eq(workflowExecutionSchedule.ownerToken, fence.ownerToken)
      )
    )
    .for(lock);
  return row !== undefined;
}

type Owned<A> = { owned: true; value: A } | { owned: false };

function answerOwned<A>(result: Owned<A>): Effect.Effect<A, Conflict> {
  return result.owned
    ? Effect.succeed(result.value)
    : Effect.fail(ownershipLost());
}

/**
 * Runs one write of a pass in a transaction that first takes the Execution's
 * schedule row, and runs nothing when the row no longer names the pass, which
 * answers `Conflict`.
 */
export function writeFenced<A>(
  database: Database["Service"],
  fence: OwnerFence,
  write: (db: Executor) => Promise<A>,
  lock: LeaseLock = "share"
): Effect.Effect<A, DatabaseError | Conflict> {
  return database
    .query((db) =>
      db.transaction(async (tx): Promise<Owned<A>> =>
        (await holdsLease(tx, fence, lock))
          ? { owned: true, value: await write(tx) }
          : { owned: false }
      )
    )
    .pipe(Effect.flatMap(answerOwned));
}

/**
 * `writeFenced` for a write that runs as a serializable transaction and is
 * retried whole when PostgreSQL aborts it. The fence is taken inside each
 * attempt, so a retry checks the lease again.
 */
export function writeFencedSerializable<A>(
  database: Database["Service"],
  fence: OwnerFence,
  write: (tx: WfGraphTransaction) => Promise<A>
): Effect.Effect<A, DatabaseError | Conflict> {
  return serializableTransaction(database, async (tx): Promise<Owned<A>> =>
    (await holdsLease(tx, fence, "share"))
      ? { owned: true, value: await write(tx) }
      : { owned: false }
  ).pipe(Effect.flatMap(answerOwned));
}

/**
 * Locks the schedule rows of Executions a terminal write is about to end, so
 * the terminal write takes them before the execution rows, in the order every
 * fenced write takes them.
 */
export async function lockSchedules(
  tx: Executor,
  executionIds: readonly string[]
): Promise<void> {
  if (executionIds.length === 0) return;
  await tx
    .select({ executionId: workflowExecutionSchedule.executionId })
    .from(workflowExecutionSchedule)
    .where(inArray(workflowExecutionSchedule.executionId, [...executionIds]))
    .orderBy(asc(workflowExecutionSchedule.executionId))
    .for("update");
}

/**
 * Closes what Executions whose terminal record this transaction wrote still
 * hold open: every wait row still `waiting` or `resuming` is cancelled, and the
 * schedule row and the step memo are deleted. Nothing claims, replays or
 * migrates a run once it is terminal, so nothing reads the memo again, and no
 * Event or Runs view action may address a park of a run that has ended. The
 * log rows stay.
 */
export async function settleEndedExecutions(
  tx: Executor,
  executionIds: readonly string[]
): Promise<void> {
  if (executionIds.length === 0) return;
  const ids = [...executionIds];
  await tx
    .update(workflowWaitStates)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(
      and(
        inArray(workflowWaitStates.executionId, ids),
        inArray(workflowWaitStates.status, ["waiting", "resuming"])
      )
    );
  await tx
    .delete(workflowExecutionSteps)
    .where(inArray(workflowExecutionSteps.executionId, ids));
  await tx
    .delete(workflowExecutionSchedule)
    .where(inArray(workflowExecutionSchedule.executionId, ids));
}

/**
 * A row the claim just leased, as its pass sees it. The claim wrote both the
 * token and the lease expiry, so a row missing either is not one it leased.
 */
export function claimedExecution(row: ExecutionSchedule): ClaimedExecution {
  if (row.ownerToken === null || row.leaseExpiresAt === null) {
    throw new Error("A claimed schedule row carries no lease");
  }
  return {
    executionId: row.executionId,
    kind: row.kind,
    ownerToken: row.ownerToken,
    attempt: row.attempt,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

/** The schedule and step memo slice of `ExecutionRepo`. */
export type ScheduleRepoMethods = {
  /**
   * Give an Execution a schedule row, `queued` and due at `wakeAt`, answering
   * whether this call inserted it. A second call for the same Execution leaves
   * the row as it stands.
   */
  readonly scheduleExecution: (input: {
    executionId: string;
    kind: ExecutionScheduleKind;
    wakeAt: Date;
  }) => Effect.Effect<boolean, DatabaseError>;
  /** One Execution's schedule row, or null when it has none. */
  readonly findSchedule: (
    executionId: string
  ) => Effect.Effect<ExecutionSchedule | null, DatabaseError>;
  /**
   * Lease up to `limit` due rows to one worker, oldest `wake_at` first.
   *
   * A row is due when it is `queued` or `waiting` with `wake_at` at or before
   * `now`, or `leased` with a lease that expired by `now`. Each claimed row gets
   * a new owner token and a lease ending `leaseMs` after `now`. The claim leaves
   * `attempt` alone, except that sweeping an expired lease counts one. Every
   * park of a claimed run still `waiting` with a deadline at or before `now` is
   * resolved as a timeout in the same transaction.
   *
   * PostgreSQL skips a row another claim has locked, so two workers claiming at
   * once never lease the same row.
   */
  readonly claimDue: (input: {
    workerId: string;
    limit: number;
    leaseMs: number;
    now: Date;
  }) => Effect.Effect<ClaimedExecution[], DatabaseError>;
  /**
   * The producer's write: resolve one park with `wake` and re-queue its run.
   *
   * The schedule row is locked first whatever state it holds. The wake is set
   * only on a row still `waiting`, so each park takes one wake. The schedule
   * row moves to `queued` only from `waiting`; a leased run's release notices
   * the wake instead.
   */
  readonly resolvePark: (input: {
    executionId: string;
    waitStateId: string;
    wake: ParkWake;
    now: Date;
  }) => Effect.Effect<ParkResolution, DatabaseError>;
  /** Every memoized step of one Execution, which a pass loads before it replays. */
  readonly listStepMemo: (
    executionId: string
  ) => Effect.Effect<StepMemoEntry[], DatabaseError>;
};

/**
 * The writes only a pass makes, each fenced on the pass. `ExecutionRepo.fenced`
 * offers them beside the fenced store writes.
 */
export type PassWrites = {
  /** Move the pass's lease to end at `leaseExpiresAt`, the worker's heartbeat. */
  readonly renewLease: (input: {
    leaseExpiresAt: Date;
  }) => Effect.Effect<void, DatabaseError | Conflict>;
  /**
   * Record one step's value. A step already recorded keeps its first value.
   * `leaseExpiresAt`, when given, renews the lease in the same transaction.
   */
  readonly writeStepMemo: (input: {
    stepId: string;
    attempt: number;
    value: JsonValue;
    leaseExpiresAt?: Date | undefined;
  }) => Effect.Effect<void, DatabaseError | Conflict>;
  /** Record which durable step parked on a wait row of the pass's run. */
  readonly recordParkStep: (input: {
    waitStateId: string;
    parkStepId: string;
  }) => Effect.Effect<void, DatabaseError | Conflict>;
  /**
   * Hand the run back after a pass that wrote no terminal record. See
   * `PassOutcome` for what each outcome writes. The schedule row is locked
   * before the run's wait rows are read, so a wake that lands during the pass
   * is never missed. The owner token and lease are cleared.
   */
  readonly releasePass: (input: {
    outcome: PassOutcome;
    now: Date;
  }) => Effect.Effect<ReleasedSchedule, DatabaseError | Conflict>;
};

/** Resolves every overdue park of the claimed runs as a timeout. */
async function resolveOverdueParks(
  tx: Executor,
  executionIds: string[],
  now: Date
): Promise<void> {
  if (executionIds.length === 0) return;
  await tx
    .update(workflowWaitStates)
    .set({ wake: TIMEOUT_WAKE, status: "resuming" })
    .where(
      and(
        inArray(workflowWaitStates.executionId, executionIds),
        eq(workflowWaitStates.status, "waiting"),
        lte(workflowWaitStates.waitUntil, now)
      )
    );
}

/**
 * Resolves every park of one run still `waiting` with `wake`, the way a
 * producer resolves one park. The caller holds the run's schedule row, so a
 * release reads these wakes once this transaction commits.
 */
export async function resolveOpenParks(
  tx: Executor,
  executionId: string,
  wake: ParkWake
): Promise<void> {
  await tx
    .update(workflowWaitStates)
    .set({ wake, status: "resuming" })
    .where(
      and(
        eq(workflowWaitStates.executionId, executionId),
        eq(workflowWaitStates.status, "waiting")
      )
    );
}

/** Builds the schedule and step memo slice of `ExecutionRepo` over one database. */
export function makeScheduleMethods(
  database: Database["Service"]
): ScheduleRepoMethods {
  return {
    scheduleExecution: (input) =>
      database.query(async (db) => {
        const inserted = await db
          .insert(workflowExecutionSchedule)
          .values({
            executionId: input.executionId,
            kind: input.kind,
            state: "queued",
            wakeAt: input.wakeAt,
          })
          .onConflictDoNothing()
          .returning({ executionId: workflowExecutionSchedule.executionId });
        return inserted.length > 0;
      }),

    findSchedule: (executionId) =>
      database.query(async (db) => {
        const [row] = await db
          .select()
          .from(workflowExecutionSchedule)
          .where(eq(workflowExecutionSchedule.executionId, executionId))
          .limit(1);
        return row ?? null;
      }),

    claimDue: (input) =>
      database.query((db) =>
        db.transaction(async (tx) => {
          const due = tx.$with("due").as(
            tx
              .select({ executionId: workflowExecutionSchedule.executionId })
              .from(workflowExecutionSchedule)
              .where(
                or(
                  and(
                    inArray(workflowExecutionSchedule.state, [
                      "queued",
                      "waiting",
                    ]),
                    lte(workflowExecutionSchedule.wakeAt, input.now)
                  ),
                  and(
                    eq(workflowExecutionSchedule.state, "leased"),
                    lte(workflowExecutionSchedule.leaseExpiresAt, input.now)
                  )
                )
              )
              .orderBy(
                asc(workflowExecutionSchedule.wakeAt),
                asc(workflowExecutionSchedule.executionId)
              )
              .limit(input.limit)
              .for("update", { skipLocked: true })
          );
          const claimed = await tx
            .with(due)
            .update(workflowExecutionSchedule)
            .set({
              state: "leased",
              ownerToken: sql`gen_random_uuid()::text`,
              leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
              workerId: input.workerId,
              // Only an expired lease counts an attempt here: the pass it cut
              // short is the failure. A row queued by a wake spends nothing.
              attempt: sql`case when ${workflowExecutionSchedule.state} = 'leased' then ${workflowExecutionSchedule.attempt} + 1 else ${workflowExecutionSchedule.attempt} end`,
            })
            .from(due)
            .where(eq(workflowExecutionSchedule.executionId, due.executionId))
            .returning();

          await resolveOverdueParks(
            tx,
            claimed.map((row) => row.executionId),
            input.now
          );

          return claimed.map(claimedExecution);
        })
      ),

    resolvePark: (input) =>
      database.query((db) =>
        db.transaction(async (tx) => {
          // Taken first and unconditionally. A conditional update alone takes
          // no lock when its predicate fails on a leased row, so a release
          // reading the wait rows in the same window would miss this wake.
          await tx
            .select({ state: workflowExecutionSchedule.state })
            .from(workflowExecutionSchedule)
            .where(eq(workflowExecutionSchedule.executionId, input.executionId))
            .for("update");
          const resolved = await tx
            .update(workflowWaitStates)
            .set({ wake: input.wake, status: "resuming" })
            .where(
              and(
                eq(workflowWaitStates.id, input.waitStateId),
                eq(workflowWaitStates.executionId, input.executionId),
                eq(workflowWaitStates.status, "waiting")
              )
            )
            .returning({ id: workflowWaitStates.id });
          const requeued = await tx
            .update(workflowExecutionSchedule)
            .set({ state: "queued", wakeAt: input.now })
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
      database.query(async (db) => {
        const rows = await db
          .select({
            stepId: workflowExecutionSteps.stepId,
            attempt: workflowExecutionSteps.attempt,
            value: workflowExecutionSteps.value,
          })
          .from(workflowExecutionSteps)
          .where(eq(workflowExecutionSteps.executionId, executionId));
        return rows.map((row) => ({ ...row, value: row.value ?? null }));
      }),
  };
}

/**
 * A memo value as a `jsonb` parameter. The driver types a JavaScript boolean
 * as a boolean parameter, which the column refuses, so the value is sent as
 * its JSON text and cast. The parameter is typed `text` first: typed `jsonb`,
 * the driver would encode the JSON text a second time.
 */
function memoJson(value: JsonValue): SQL {
  return sql`${JSON.stringify(value)}::text::jsonb`;
}

/** Builds the writes only a pass makes, fenced on `fence`. */
export function makePassWrites(
  database: Database["Service"],
  fence: OwnerFence
): PassWrites {
  const { executionId } = fence;
  return {
    renewLease: (input) =>
      writeFenced(
        database,
        fence,
        async (tx) => {
          await tx
            .update(workflowExecutionSchedule)
            .set({ leaseExpiresAt: input.leaseExpiresAt })
            .where(eq(workflowExecutionSchedule.executionId, executionId));
        },
        "update"
      ),

    writeStepMemo: (input) =>
      writeFenced(
        database,
        fence,
        async (tx) => {
          await tx
            .insert(workflowExecutionSteps)
            .values({
              executionId,
              stepId: input.stepId,
              attempt: input.attempt,
              value: memoJson(input.value),
            })
            .onConflictDoNothing();
          if (input.leaseExpiresAt !== undefined) {
            await tx
              .update(workflowExecutionSchedule)
              .set({ leaseExpiresAt: input.leaseExpiresAt })
              .where(eq(workflowExecutionSchedule.executionId, executionId));
          }
        },
        input.leaseExpiresAt === undefined ? "share" : "update"
      ),

    recordParkStep: (input) =>
      writeFenced(database, fence, async (tx) => {
        await tx
          .update(workflowWaitStates)
          .set({ parkStepId: input.parkStepId })
          .where(
            and(
              eq(workflowWaitStates.id, input.waitStateId),
              eq(workflowWaitStates.executionId, executionId)
            )
          );
      }),

    releasePass: (input) =>
      writeFenced(
        database,
        fence,
        async (tx) => {
          const [schedule] = await tx
            .select({ attempt: workflowExecutionSchedule.attempt })
            .from(workflowExecutionSchedule)
            .where(eq(workflowExecutionSchedule.executionId, executionId));
          const attempt = schedule?.attempt ?? 0;
          const parks = await tx
            .select({
              status: workflowWaitStates.status,
              waitUntil: workflowWaitStates.waitUntil,
              woken: sql<boolean>`${workflowWaitStates.wake} is not null`,
            })
            .from(workflowWaitStates)
            .where(
              and(
                eq(workflowWaitStates.executionId, executionId),
                inArray(workflowWaitStates.status, ["waiting", "resuming"])
              )
            );

          if (input.outcome.kind === "retries_spent") {
            await tx
              .insert(workflowExecutionSteps)
              .values({
                executionId,
                stepId: input.outcome.stepId,
                attempt,
                value: memoJson(input.outcome.failure),
              })
              .onConflictDoNothing();
          }

          const released = decideRelease({
            outcome: input.outcome,
            attempt,
            now: input.now,
            parks,
          });
          await tx
            .update(workflowExecutionSchedule)
            .set({
              state: released.state,
              wakeAt: released.wakeAt,
              attempt: released.attempt,
              lastError: released.lastError,
              leaseExpiresAt: null,
              ownerToken: null,
              workerId: null,
            })
            .where(eq(workflowExecutionSchedule.executionId, executionId));
          return {
            state: released.state,
            wakeAt: released.wakeAt,
            attempt: released.attempt,
          };
        },
        "update"
      ),
  };
}
