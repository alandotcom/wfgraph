/**
 * The `workflow_execution_schedule` and `workflow_execution_steps` slice of
 * `ExecutionRepo`, which the database executor runs on, and the PostgreSQL
 * locking a fenced write stands on. `release-policy.ts` makes the decisions;
 * this file runs the statements they call for.
 *
 * Lock order: every transaction here, and every fenced or terminal write and
 * Migration repin in the sibling slices, takes the run's schedule row before
 * its execution row and its wait rows. The producers and the release all lock
 * the schedule row first, so a wake either commits before a release reads the
 * wait rows or finds the row `waiting` after the release commits.
 */

import { and, asc, eq, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import { sortBy } from "es-toolkit/array";
import {
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
  type LeaseLost,
  serializableTransaction,
} from "#src/backend/lib/effect/database";
import type {
  ClaimedExecution,
  CountedStepFailure,
  ExecutionSchedule,
  OwnerFence,
  ParkResolution,
  ParkWake,
  PassOutcome,
  ReleasedPass,
  StepMemo,
  StepMemoEntry,
} from "#src/backend/services/executions/repo/contracts";
import {
  claimAttempt,
  countStepFailure,
  decideRelease,
  LEASE_EXPIRED_ERROR,
  OPEN_PARK_STATUSES,
  sweptStepFailures,
  TIMEOUT_WAKE,
} from "#src/backend/services/executions/repo/release-policy";
import { ownershipLost } from "#src/backend/services/executions/repo/fencing";
import type { JsonValue } from "@wfgraph/shared/types/json";

type Executor = WfGraphDatabase | WfGraphTransaction;

/** How strongly a fenced write holds the schedule row it stands on. */
export type LeaseLock = "share" | "update";

/**
 * Takes the pass's schedule row when it is still leased under the fence's
 * token and still names the fence's Execution, answering whether it was.
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
    .for(lock);
  return row !== undefined;
}

type Owned<A> = { owned: true; value: A } | { owned: false };

function answerOwned<A>(result: Owned<A>): Effect.Effect<A, LeaseLost> {
  return result.owned
    ? Effect.succeed(result.value)
    : Effect.fail(ownershipLost());
}

/**
 * Runs one write of a pass in a transaction that first takes the pass's
 * schedule row, and runs nothing when the row no longer names the pass, which
 * answers `LeaseLost`.
 */
export function writeFenced<A>(
  database: Database["Service"],
  fence: OwnerFence,
  write: (db: Executor) => Promise<A>,
  lock: LeaseLock = "share"
): Effect.Effect<A, DatabaseError | LeaseLost> {
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
): Effect.Effect<A, DatabaseError | LeaseLost> {
  return serializableTransaction(database, async (tx): Promise<Owned<A>> =>
    (await holdsLease(tx, fence, "share"))
      ? { owned: true, value: await write(tx) }
      : { owned: false }
  ).pipe(Effect.flatMap(answerOwned));
}

/**
 * Locks the schedule rows of the runs a write is about to change, so the write
 * takes them before the execution rows, in the order every fenced write takes
 * them. A run with no schedule row has nothing to lock.
 */
export async function lockSchedules(
  tx: Executor,
  executionIds: readonly string[]
): Promise<void> {
  if (executionIds.length === 0) return;
  await tx
    .select({ id: workflowExecutionSchedule.id })
    .from(workflowExecutionSchedule)
    .where(inArray(workflowExecutionSchedule.executionId, [...executionIds]))
    .orderBy(asc(workflowExecutionSchedule.id))
    .for("update");
}

/**
 * Closes what runs whose terminal record this transaction wrote still hold
 * open, as `OPEN_PARK_STATUSES` describes: their open wait rows are cancelled
 * and their schedule rows are deleted, which deletes the step memo by cascade.
 */
async function settleEndedExecutions(
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
        inArray(workflowWaitStates.status, [...OPEN_PARK_STATUSES])
      )
    );
  await tx
    .delete(workflowExecutionSchedule)
    .where(inArray(workflowExecutionSchedule.executionId, ids));
}

/**
 * Runs a write that may make runs terminal, as one transaction.
 *
 * The candidates' schedule rows are locked first, in the order every fenced
 * write takes them. `write` reports which runs it ended, and their open wait
 * rows, schedule rows and step memos are settled before the transaction
 * commits. Inside a fenced write the transaction is a savepoint of the fenced
 * one.
 */
export function endExecutions<A>(
  db: Executor,
  candidateIds: readonly string[],
  write: (
    tx: WfGraphTransaction
  ) => Promise<{ result: A; ended: readonly string[] }>
): Promise<A> {
  return db.transaction(async (tx) => {
    await lockSchedules(tx, candidateIds);
    const { result, ended } = await write(tx);
    await settleEndedExecutions(tx, ended);
    return result;
  });
}

/**
 * A row the claim just leased, as its pass sees it. The claim wrote the token
 * and the lease expiry and claims only `run` rows, so a row missing any of
 * them is a defect.
 */
export function claimedExecution(
  row: ExecutionSchedule
): Effect.Effect<ClaimedExecution> {
  if (
    row.kind !== "run" ||
    row.ownerToken === null ||
    row.leaseExpiresAt === null ||
    row.executionId === null
  ) {
    return Effect.die(
      new Error(`The claimed schedule row ${row.id} carries no lease or run`)
    );
  }
  return Effect.succeed({
    kind: row.kind,
    scheduleId: row.id,
    executionId: row.executionId,
    ownerToken: row.ownerToken,
    attempt: row.attempt,
    leaseExpiresAt: row.leaseExpiresAt,
  });
}

/** The rows a claim leased, oldest `wake_at` first, as their passes see them. */
export function claimedExecutions(
  rows: readonly ExecutionSchedule[]
): Effect.Effect<ClaimedExecution[]> {
  return Effect.forEach(
    sortBy(rows, [(row) => row.wakeAt.getTime(), (row) => row.id]),
    claimedExecution
  );
}

/** A memo row's columns, as both backends read them back. */
export type StepMemoColumns = {
  status: string;
  failures: number;
  value: JsonValue | null;
  error: string | null;
};

/** A memo row's columns as a `StepMemo`. The table's checks keep them consistent. */
export function stepMemoOf(row: StepMemoColumns): StepMemo {
  const { status, failures, error } = row;
  if (status === "succeeded") {
    return { status, failures, value: row.value ?? null };
  }
  if ((status === "failing" || status === "failed") && error !== null) {
    return { status, failures, error };
  }
  throw new Error(`A step memo row holds the invalid status ${status}`);
}

/** The schedule and step memo slice of `ExecutionRepo`. */
export type ScheduleRepoMethods = {
  /**
   * Give a run a schedule row, `queued` and due at `wakeAt`, answering whether
   * this call inserted it. A second call for the same run leaves the row as it
   * stands.
   */
  readonly scheduleExecution: (input: {
    executionId: string;
    kind: "run";
    wakeAt: Date;
  }) => Effect.Effect<boolean, DatabaseError>;
  /** One run's schedule row, or null when it has none. */
  readonly findSchedule: (
    executionId: string
  ) => Effect.Effect<ExecutionSchedule | null, DatabaseError>;
  /**
   * Lease up to `limit` due run rows to one worker, oldest `wake_at` first.
   *
   * A row is due when it is `queued` or `waiting` with `wake_at` at or before
   * `now`, or `leased` with a lease that expired by `now`. Each claimed row gets
   * a new owner token and a lease ending `leaseMs` after `now`. A row queued by
   * a wake or a release spends nothing. Sweeping an expired lease counts one
   * failure against the step the row recorded as running, or against the run's
   * own count when it recorded none (`release-policy.ts`). Every park of a
   * claimed run still `waiting` with a deadline at or before `now` is resolved
   * as a timeout in the same transaction.
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
   * row moves to `queued` only when this call set the wake and only from
   * `waiting`; a leased run's release notices the wake instead.
   */
  readonly resolvePark: (input: {
    executionId: string;
    waitStateId: string;
    wake: ParkWake;
    now: Date;
  }) => Effect.Effect<ParkResolution, DatabaseError>;
  /**
   * Take one run's schedule row back from whichever pass holds it, answering
   * whether the run had a row.
   *
   * The row loses its owner token, lease, worker and running step and becomes
   * `queued`, due at `now`, with its failure count unchanged. A pass that held
   * the lease has its next fenced write refused with `LeaseLost`. The next
   * claim's pass finds the run as it now stands, and drops the row of a run
   * that has ended.
   */
  readonly revokeLease: (input: {
    executionId: string;
    now: Date;
  }) => Effect.Effect<boolean, DatabaseError>;
  /**
   * Every memo row of one run's schedule row, which a pass loads before it
   * replays. A run with no schedule row has none.
   */
  readonly listStepMemo: (
    executionId: string
  ) => Effect.Effect<StepMemoEntry[], DatabaseError>;
};

/**
 * The writes only a pass makes, each fenced on the pass. `ExecutionRepo.fenced`
 * offers them beside the fenced store writes.
 */
export type PassWrites = {
  /**
   * The worker's heartbeat: move the pass's lease to end at `leaseExpiresAt`
   * and record which step the pass is running, null between steps.
   */
  readonly renewLease: (input: {
    leaseExpiresAt: Date;
    runningStepId: string | null;
  }) => Effect.Effect<void, DatabaseError | LeaseLost>;
  /**
   * Record one step's value and renew the lease to `leaseExpiresAt`, in one
   * transaction holding the schedule row for update. A step already
   * `succeeded` or `failed` keeps its row; a `failing` step's row becomes
   * `succeeded` with this value and keeps its failure count. The schedule row
   * stops naming the step as running.
   */
  readonly writeStepMemo: (input: {
    stepId: string;
    value: JsonValue;
    leaseExpiresAt: Date;
  }) => Effect.Effect<void, DatabaseError | LeaseLost>;
  /** Record which durable step parked on a wait row of the pass's run. */
  readonly recordParkStep: (input: {
    waitStateId: string;
    parkStepId: string;
  }) => Effect.Effect<void, DatabaseError | LeaseLost>;
  /**
   * Hand the run back after a pass that wrote no terminal record. See
   * `PassOutcome` for what each outcome writes. The schedule row is locked
   * before the run's wait rows are read, so a wake that lands during the pass
   * is never missed. The owner token, lease and running step are cleared.
   */
  readonly releasePass: (input: {
    outcome: PassOutcome;
    now: Date;
  }) => Effect.Effect<ReleasedPass, DatabaseError | LeaseLost>;
  /**
   * Delete the pass's schedule row, and its step memo with it, for a pass that
   * found its run no longer in flight: nothing will run it again.
   */
  readonly dropSchedule: () => Effect.Effect<void, DatabaseError | LeaseLost>;
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

/**
 * Moves one run's schedule row from `waiting` to `queued` at `now`, answering
 * whether it moved. A `leased` row is left for its release, which reads the
 * wakes this transaction wrote. The caller holds the schedule row.
 */
export async function requeueWaitingRun(
  tx: Executor,
  executionId: string,
  now: Date
): Promise<boolean> {
  const requeued = await tx
    .update(workflowExecutionSchedule)
    .set({ state: "queued", wakeAt: now })
    .where(
      and(
        eq(workflowExecutionSchedule.executionId, executionId),
        eq(workflowExecutionSchedule.state, "waiting")
      )
    )
    .returning({ id: workflowExecutionSchedule.id });
  return requeued.length > 0;
}

const memoColumns = {
  stepId: workflowExecutionSteps.stepId,
  status: workflowExecutionSteps.status,
  failures: workflowExecutionSteps.failures,
  value: workflowExecutionSteps.value,
  error: workflowExecutionSteps.error,
};

/**
 * Counts one failure against a step's memo row, as `countStepFailure`
 * decides, answering the row it wrote. The caller holds the schedule row.
 */
async function countFailureOnStep(
  tx: Executor,
  input: { scheduleId: string; stepId: string; error: string }
): Promise<CountedStepFailure | null> {
  const [row] = await tx
    .select(memoColumns)
    .from(workflowExecutionSteps)
    .where(
      and(
        eq(workflowExecutionSteps.scheduleId, input.scheduleId),
        eq(workflowExecutionSteps.stepId, input.stepId)
      )
    );
  const counted = countStepFailure(
    row === undefined ? undefined : stepMemoOf(row),
    input.error
  );
  if (counted === null) return null;
  await tx
    .insert(workflowExecutionSteps)
    .values({
      scheduleId: input.scheduleId,
      stepId: input.stepId,
      status: counted.status,
      failures: counted.failures,
      error: counted.error,
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
          .returning({ id: workflowExecutionSchedule.id });
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
      database
        .query((db) =>
          db.transaction(async (tx) => {
            const due = await tx
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
                      lte(workflowExecutionSchedule.wakeAt, input.now)
                    ),
                    and(
                      eq(workflowExecutionSchedule.state, "leased"),
                      lte(workflowExecutionSchedule.leaseExpiresAt, input.now)
                    )
                  )
                )
              )
              .orderBy(
                asc(workflowExecutionSchedule.wakeAt),
                asc(workflowExecutionSchedule.id)
              )
              .limit(input.limit)
              .for("update", { skipLocked: true });
            if (due.length === 0) return [];

            const claimed = await tx
              .update(workflowExecutionSchedule)
              .set({
                state: "leased",
                ownerToken: sql`gen_random_uuid()::text`,
                leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
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
              // eslint-disable-next-line eslint/no-await-in-loop -- one transaction runs one statement at a time
              await countFailureOnStep(tx, {
                ...swept,
                error: LEASE_EXPIRED_ERROR,
              });
            }
            await resolveOverdueParks(
              tx,
              claimed.flatMap((row) =>
                row.executionId === null ? [] : [row.executionId]
              ),
              input.now
            );
            return claimed;
          })
        )
        .pipe(Effect.flatMap(claimedExecutions)),

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
          if (resolved.length === 0) {
            return { resolved: false, requeued: false };
          }
          return {
            resolved: true,
            requeued: await requeueWaitingRun(tx, input.executionId, input.now),
          };
        })
      ),

    revokeLease: (input) =>
      database.query(async (db) => {
        const revoked = await db
          .update(workflowExecutionSchedule)
          .set({
            state: "queued",
            wakeAt: input.now,
            ownerToken: null,
            leaseExpiresAt: null,
            workerId: null,
            runningStepId: null,
          })
          .where(eq(workflowExecutionSchedule.executionId, input.executionId))
          .returning({ id: workflowExecutionSchedule.id });
        return revoked.length > 0;
      }),

    listStepMemo: (executionId) =>
      database.query(async (db) => {
        const rows = await db
          .select(memoColumns)
          .from(workflowExecutionSteps)
          .innerJoin(
            workflowExecutionSchedule,
            eq(workflowExecutionSchedule.id, workflowExecutionSteps.scheduleId)
          )
          .where(eq(workflowExecutionSchedule.executionId, executionId));
        return rows.map((row) => ({ stepId: row.stepId, ...stepMemoOf(row) }));
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
  const { scheduleId, executionId } = fence;
  const thisSchedule = eq(workflowExecutionSchedule.id, scheduleId);
  return {
    renewLease: (input) =>
      writeFenced(
        database,
        fence,
        async (tx) => {
          await tx
            .update(workflowExecutionSchedule)
            .set({
              leaseExpiresAt: input.leaseExpiresAt,
              runningStepId: input.runningStepId,
            })
            .where(thisSchedule);
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
              scheduleId,
              stepId: input.stepId,
              status: "succeeded",
              value: memoJson(input.value),
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
          await tx
            .update(workflowExecutionSchedule)
            .set({
              leaseExpiresAt: input.leaseExpiresAt,
              runningStepId: sql`nullif(${workflowExecutionSchedule.runningStepId}, ${input.stepId})`,
            })
            .where(thisSchedule);
        },
        "update"
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
            .where(thisSchedule);
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
                inArray(workflowWaitStates.status, [...OPEN_PARK_STATUSES])
              )
            );
          const { outcome } = input;
          const countedStep =
            outcome.kind === "step_failed"
              ? await countFailureOnStep(tx, {
                  scheduleId,
                  stepId: outcome.stepId,
                  error: outcome.error,
                })
              : null;

          const released = decideRelease({
            outcome,
            attempt: schedule?.attempt ?? 0,
            now: input.now,
            parks,
            countedStep,
          });
          await tx
            .update(workflowExecutionSchedule)
            .set({
              state: released.state,
              wakeAt: released.wakeAt,
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
        },
        "update"
      ),

    dropSchedule: () =>
      writeFenced(
        database,
        fence,
        async (tx) => {
          await tx.delete(workflowExecutionSchedule).where(thisSchedule);
        },
        "update"
      ),
  };
}
