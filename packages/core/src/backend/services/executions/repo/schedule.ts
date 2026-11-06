/**
 * The `workflow_execution_schedule` and `workflow_execution_steps` slice of
 * `ExecutionRepo`, which the database executor runs on, and the PostgreSQL
 * locking a fenced write stands on. `release-policy.ts` makes the decisions;
 * this file runs the statements they call for.
 *
 * Lock order: every transaction here, and every fenced or terminal write and
 * producer in the sibling slices, takes the run's schedule row before its
 * execution row and its wait rows. The producers (`wakeExecutions`) and the
 * release all lock the schedule row first, so a wake either commits before a
 * release reads the wait rows or finds the row `waiting` after the release
 * commits.
 */

import { and, asc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
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
  ClaimedSchedule,
  ClaimLane,
  CountedStepFailure,
  ExecutionSchedule,
  ParkResolution,
  ParkWake,
  PassFence,
  PassOutcome,
  ReleasedPass,
  RunFence,
  ScheduleRowKey,
  StepMemoEntry,
} from "#src/backend/services/executions/repo/contracts";
import {
  claimAttempt,
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
  stepFailureOf,
  type StepFailure,
  stepMemoOf,
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
 * token (`leasedUnderFence`), answering whether it was.
 *
 * `share` lets the pass's concurrent writes stand on the row together while a
 * claim, a release, a producer or a terminal write waits for them. `update` is
 * for a write that changes or deletes the row itself.
 */
async function holdsLease(
  tx: Executor,
  fence: PassFence,
  lock: LeaseLock
): Promise<boolean> {
  const [row] = await tx
    .select({ id: workflowExecutionSchedule.id })
    .from(workflowExecutionSchedule)
    .where(leasedUnderFence(workflowExecutionSchedule, fence))
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
  fence: PassFence,
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
  fence: RunFence,
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
        openPark(workflowWaitStates)
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
 * Runs a producer's write as one transaction: a write that resolves parks of
 * some runs, after which the schedule rows of the runs it woke are made due.
 *
 * `candidates` names the runs the write may wake, read inside the transaction.
 * Their schedule rows are locked first, ordered by id, whatever state each
 * holds: a conditional update alone takes no lock when its predicate fails on
 * a `leased` row, so a release reading the wait rows in the same window would
 * miss the wake. `write` then reports which of the candidates it woke, and
 * each of their schedule rows that `requeuedByWake` takes becomes `queued` and
 * due at `now` at the latest. Answers the write's result and the schedule rows
 * it made due. Inside a fenced write the transaction is a savepoint of the
 * fenced one.
 */
export function wakeExecutions<A>(
  db: Executor,
  input: {
    now: Date;
    candidates: (tx: WfGraphTransaction) => Promise<readonly string[]>;
  },
  write: (
    tx: WfGraphTransaction,
    candidateIds: readonly string[]
  ) => Promise<{ result: A; woken: readonly string[] }>
): Promise<{ result: A; due: DueSchedule[] }> {
  return db.transaction(async (tx) => {
    const candidateIds = await input.candidates(tx);
    await lockSchedules(tx, candidateIds);
    const { result, woken } = await write(tx, candidateIds);
    return { result, due: await requeueWokenRuns(tx, woken, input.now) };
  });
}

/**
 * Makes due the schedule rows of the runs a producer woke, as
 * `wakeExecutions` describes, answering the rows it made due. The caller holds
 * them.
 */
async function requeueWokenRuns(
  tx: Executor,
  executionIds: readonly string[],
  now: Date
): Promise<DueSchedule[]> {
  if (executionIds.length === 0) return [];
  return tx
    .update(workflowExecutionSchedule)
    .set({
      state: "queued",
      wakeAt: requeuedWakeAt(workflowExecutionSchedule, now),
    })
    .where(
      and(
        inArray(workflowExecutionSchedule.executionId, [...executionIds]),
        requeuedByWake(workflowExecutionSchedule, now)
      )
    )
    .returning({
      scheduleId: workflowExecutionSchedule.id,
      executionId: workflowExecutionSchedule.executionId,
    });
}

/**
 * Gives a run its schedule row, `queued` and due at `wakeAt`, inside the
 * transaction that inserts the run's execution row (`startForEntity`).
 */
export async function insertRunSchedule(
  tx: WfGraphTransaction,
  input: { executionId: string; wakeAt: Date }
): Promise<void> {
  await tx.insert(workflowExecutionSchedule).values({
    executionId: input.executionId,
    kind: "run",
    state: "queued",
    wakeAt: input.wakeAt,
  });
}

/** The schedule and step memo slice of `ExecutionRepo`. */
export type ScheduleRepoMethods = {
  /** One schedule row, or null when there is none. */
  readonly findSchedule: (
    row: ScheduleRowKey
  ) => Effect.Effect<ExecutionSchedule | null, DatabaseError>;
  /**
   * Lease to one worker, for each of `lanes`, up to the lane's `limit` due
   * rows of the lane's kind, oldest `wake_at` first, and answer every leased
   * row oldest `wake_at` first. One statement reads the due rows of every
   * lane, so a claim costs one round trip however many lanes it has.
   *
   * A row is due as `dueSchedule` decides: of the lane's kind, and `queued`
   * or `waiting` with `wake_at` at or before `now`, or `leased` with a lease
   * that expired by `now`. Each claimed row gets
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
    lanes: readonly ClaimLane[];
    workerId: string;
    leaseMs: number;
    now: Date;
  }) => Effect.Effect<ClaimedSchedule[], DatabaseError>;
  /**
   * Write `wake` onto one park by its row id and make its run due, which is
   * how the replay harness plays whichever producer resolves that park. A
   * producer the application runs claims its park by what it knows instead
   * (`claimWaitingStateById`, `requestCancelForEntity`, `repinVersion`).
   *
   * Runs through `wakeExecutions`. The wake is set only on a row still
   * `waiting`, so each park takes one wake, and only a wake this call set
   * makes the run due; a leased run's release notices the wake instead.
   */
  readonly wakePark: (input: {
    executionId: string;
    waitStateId: string;
    wake: ParkWake;
    now: Date;
  }) => Effect.Effect<ParkResolution, DatabaseError>;
  /**
   * Every memo row of one schedule row, which a pass loads before it replays.
   * A row that does not exist has none.
   */
  readonly listStepMemo: (
    row: ScheduleRowKey
  ) => Effect.Effect<StepMemoEntry[], DatabaseError>;
};

/**
 * The writes every pass makes, whatever its row runs, each fenced on the
 * pass. `ExecutionRepo.fenced` offers them beside the fenced store writes and
 * `ParkWrites`, and `ExecutionRepo.fencedDelivery` offers them alone.
 */
export type PassWrites = {
  /**
   * The worker's heartbeat: move the pass's lease to end at `leaseExpiresAt`
   * and record which step the pass is running, null between steps.
   */
  readonly renewLease: (input: {
    leaseExpiresAt: Date;
    runningStepId: string | null;
    /** The node `runningStepId` does work for, or null. */
    runningNodeId: string | null;
  }) => Effect.Effect<void, DatabaseError | LeaseLost>;
  /**
   * Record one step's value and renew the lease to `leaseExpiresAt`, in one
   * transaction holding the schedule row for update. A step already
   * `succeeded` or `failed` keeps its row; a `failing` step's row becomes
   * `succeeded` with this value and keeps its failure count. The schedule row
   * stops naming the step as running. A row this write creates carries
   * `nodeId`, the node the step does work for, or null for a step of no node.
   */
  readonly writeStepMemo: (input: {
    stepId: string;
    nodeId: string | null;
    value: JsonValue;
    leaseExpiresAt: Date;
  }) => Effect.Effect<void, DatabaseError | LeaseLost>;
  /**
   * Hand the row back after a pass that did not end its row's subject. See
   * `PassOutcome` for what each outcome writes. The schedule row is locked
   * before the wait rows of the run it runs are read, so a wake that lands
   * during the pass is never missed. The owner token, lease and running step
   * are cleared.
   */
  readonly releasePass: (input: {
    outcome: PassOutcome;
    now: Date;
  }) => Effect.Effect<ReleasedPass, DatabaseError | LeaseLost>;
  /**
   * Delete the pass's schedule row, and its step memo with it, for a pass that
   * found its subject already ended: nothing will run it again.
   */
  readonly dropSchedule: () => Effect.Effect<void, DatabaseError | LeaseLost>;
};

/** The write a pass over a `run` row makes when one of its Waits parks. */
export type ParkWrites = {
  /** Record which durable step parked on a wait row of the run the pass's row runs. */
  readonly recordParkStep: (input: {
    waitStateId: string;
    parkStepId: string;
  }) => Effect.Effect<void, DatabaseError | LeaseLost>;
};

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
        overduePark(workflowWaitStates, now)
      )
    );
}

/**
 * Resolves every park still `waiting` of the runs named with `wake`, the way a
 * producer resolves one park, answering the run of each park it resolved, once
 * per park. The caller holds the runs' schedule rows, so a release reads these
 * wakes once this transaction commits.
 */
export async function resolveOpenParks(
  tx: Executor,
  executionIds: readonly string[],
  wake: ParkWake
): Promise<string[]> {
  if (executionIds.length === 0) return [];
  const resolved = await tx
    .update(workflowWaitStates)
    .set({ wake, status: "resuming" })
    .where(
      and(
        inArray(workflowWaitStates.executionId, [...executionIds]),
        eq(workflowWaitStates.status, "waiting")
      )
    )
    .returning({ executionId: workflowWaitStates.executionId });
  return resolved.map((row) => row.executionId);
}

const memoColumns = {
  stepId: workflowExecutionSteps.stepId,
  nodeId: workflowExecutionSteps.nodeId,
  status: workflowExecutionSteps.status,
  failures: workflowExecutionSteps.failures,
  value: workflowExecutionSteps.value,
  error: workflowExecutionSteps.error,
};

/**
 * Counts one failure against a step's memo row, as `countStepFailure`
 * decides, answering the row it wrote. A row this creates carries the step's
 * node id. The caller holds the schedule row.
 */
async function countFailureOnStep(
  tx: Executor,
  input: StepFailure & { scheduleId: string }
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
      nodeId: input.nodeId,
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
    findSchedule: (key) =>
      database.query(async (db) => {
        const [row] = await db
          .select()
          .from(workflowExecutionSchedule)
          .where(scheduleRow(key))
          .limit(1);
        return row ?? null;
      }),

    claimDue: (input) =>
      database
        .query((db) =>
          db.transaction(async (tx) => {
            const lanes = input.lanes.filter((lane) => lane.limit > 0);
            if (lanes.length === 0) return [];
            // One select reads every lane: each lane is a locking subquery
            // limited to its own rows, because PostgreSQL refuses `for update`
            // on a union.
            const due = await tx
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
                      tx
                        .select({ id: workflowExecutionSchedule.id })
                        .from(workflowExecutionSchedule)
                        .where(
                          dueSchedule(workflowExecutionSchedule, {
                            kind: lane.kind,
                            now: input.now,
                          })
                        )
                        .orderBy(
                          asc(workflowExecutionSchedule.wakeAt),
                          asc(workflowExecutionSchedule.id)
                        )
                        .limit(lane.limit)
                        .for("update", { skipLocked: true })
                    )
                  )
                )
              );
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
                runningNodeId: null,
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
              await countFailureOnStep(tx, swept);
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
        .pipe(Effect.flatMap(claimedSchedules)),

    wakePark: (input) =>
      database
        .query((db) =>
          wakeExecutions(
            db,
            { now: input.now, candidates: async () => [input.executionId] },
            async (tx) => {
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
                .returning({ executionId: workflowWaitStates.executionId });
              return {
                result: resolved.length > 0,
                woken: resolved.map((row) => row.executionId),
              };
            }
          )
        )
        .pipe(Effect.map(parkResolution)),

    listStepMemo: (key) =>
      database.query(async (db) => {
        const rows = await db
          .select(memoColumns)
          .from(workflowExecutionSteps)
          .innerJoin(
            workflowExecutionSchedule,
            eq(workflowExecutionSchedule.id, workflowExecutionSteps.scheduleId)
          )
          .where(scheduleRow(key));
        return rows.map((row) => ({
          stepId: row.stepId,
          nodeId: row.nodeId,
          ...stepMemoOf(row),
        }));
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

/** Builds the writes every pass makes, fenced on `fence`. */
export function makePassWrites(
  database: Database["Service"],
  fence: PassFence
): PassWrites {
  const { scheduleId } = fence;
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
              runningNodeId: input.runningNodeId,
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
              nodeId: input.nodeId,
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
              ...runningAfterMemo(workflowExecutionSchedule, input.stepId),
            })
            .where(thisSchedule);
        },
        "update"
      ),

    releasePass: (input) =>
      writeFenced(
        database,
        fence,
        async (tx) => {
          const [schedule] = await tx
            .select({
              attempt: workflowExecutionSchedule.attempt,
              executionId: workflowExecutionSchedule.executionId,
            })
            .from(workflowExecutionSchedule)
            .where(thisSchedule);
          const executionId = schedule?.executionId ?? null;
          const parks =
            executionId === null
              ? []
              : await tx
                  .select({
                    status: workflowWaitStates.status,
                    waitUntil: workflowWaitStates.waitUntil,
                    woken: sql<boolean>`${workflowWaitStates.wake} is not null`,
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
              : await countFailureOnStep(tx, { scheduleId, ...stepFailure });

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
              runningNodeId: null,
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

/**
 * Builds the write a pass over a `run` row makes when a Wait parks. The fence
 * holds the schedule row to the fence's Execution, so the wait row is held to
 * the same run.
 */
export function makeParkWrites(
  database: Database["Service"],
  fence: RunFence
): ParkWrites {
  return {
    recordParkStep: (input) =>
      writeFenced(database, fence, async (tx) => {
        await tx
          .update(workflowWaitStates)
          .set({ parkStepId: input.parkStepId })
          .where(
            and(
              eq(workflowWaitStates.id, input.waitStateId),
              eq(workflowWaitStates.executionId, fence.executionId)
            )
          );
      }),
  };
}
