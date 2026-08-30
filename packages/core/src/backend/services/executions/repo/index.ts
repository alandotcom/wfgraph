import { and, eq, inArray } from "drizzle-orm";
import { Context, Duration, Effect, Layer, Schedule } from "effect";
import { partition } from "es-toolkit";
import {
  workflowExecutionEvents,
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type {
  WfGraphDatabase,
  WfGraphTransaction,
} from "#src/backend/lib/db/index";
import {
  Database,
  type DatabaseError,
  hasDatabaseErrorCode,
} from "#src/backend/lib/effect/database";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import type { Concurrency } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  type AuditRepoMethods,
  makeAuditMethods,
} from "#src/backend/services/executions/repo/audit";
import {
  type NodeLogsRepoMethods,
  makeNodeLogsMethods,
} from "#src/backend/services/executions/repo/node-logs";
import {
  makeRunsMethods,
  type RunsRepoMethods,
} from "#src/backend/services/executions/repo/runs";
import {
  makeWaitsMethods,
  type WaitsRepoMethods,
} from "#src/backend/services/executions/repo/waits";
import type {
  EntityStartOutcome,
  NewExecution,
} from "#src/backend/services/executions/repo/contracts";

export * from "#src/backend/services/executions/repo/contracts";

/**
 * How long a run may sit with its row committed and `enqueued_at` unstamped
 * before the next start for its entity treats it as one the bus was never told
 * about.
 *
 * The send follows the commit by milliseconds, so anything still unstamped after
 * this had its process die in between. The window is generous because the cost of
 * being wrong is a live run stamped `failed`, which is why the caller signals a
 * reclaimed run to stop rather than only relabelling it.
 */
export const UNSENT_RUN_GRACE_MS = 5 * 60 * 1000;

/** The sentence run history carries for a run that never reached the bus. */
export const UNSENT_RUN_RECLAIM_REASON =
  "The run was opened but never reached the bus, so a later start for this entity closed it";

const SERIALIZATION_RETRIES = 5;
const SERIALIZATION_RETRY_BASE_DELAY = Duration.millis(5);

/**
 * Backoff, because the racers abort together and would otherwise retry together.
 *
 * `Effect.retry` with a plain attempt count reschedules every aborted decision
 * at once, so a burst of starts for one entity keeps colliding at full speed
 * and burns its attempts on the same conflict. Jitter spreads them; the delays
 * are small because a start is on a run's critical path.
 */
const serializationRetrySchedule = Schedule.exponential(
  SERIALIZATION_RETRY_BASE_DELAY,
  2
).pipe(Schedule.jittered, Schedule.upTo({ times: SERIALIZATION_RETRIES }));

/**
 * SQLSTATE 40001 is what PostgreSQL raises when SERIALIZABLE aborts one of two
 * decisions that read and wrote the same predicate, and it is the whole reason
 * the start below is retried rather than failed. SQLite serializes its writes
 * with BEGIN IMMEDIATE and raises nothing of the kind, so this only ever
 * matches under the PostgreSQL backend.
 */
const SERIALIZATION_FAILURE_CODE = "40001";

function isSerializationFailure(error: DatabaseError): boolean {
  return hasDatabaseErrorCode(error, SERIALIZATION_FAILURE_CODE);
}

function isStuckBeforeTheBus(row: {
  enqueuedAt: Date | null;
  startedAt: Date;
}): boolean {
  return (
    row.enqueuedAt === null &&
    Date.now() - row.startedAt.getTime() > UNSENT_RUN_GRACE_MS
  );
}

/**
 * Closes the rows a crash left between their commit and the send, answering the
 * ones this call closed.
 *
 * The in-flight guard is what keeps a run that woke up and finished in the
 * meantime from being overwritten.
 */
async function reclaimStuckRuns(
  tx: WfGraphTransaction,
  executionIds: string[]
): Promise<string[]> {
  if (executionIds.length === 0) {
    return [];
  }

  const reclaimed = await tx
    .update(workflowExecutions)
    .set({
      status: "failed",
      waitingAt: null,
      completedAt: new Date(),
      error: UNSENT_RUN_RECLAIM_REASON,
    })
    .where(
      and(
        inArray(workflowExecutions.id, executionIds),
        inArray(workflowExecutions.status, [...IN_FLIGHT_EXECUTION_STATUSES])
      )
    )
    .returning({ id: workflowExecutions.id });

  return reclaimed.map((row) => row.id);
}

/**
 * The two methods that touch more than one table in one transaction, which is
 * the reason `ExecutionRepo` is one service rather than four: `startForEntity`
 * writes `workflow_executions` and `workflow_wait_states` inside one serializable
 * transaction, and `deleteAllForWorkflow` deletes the runs and the workflow-scoped audit
 * rows together. Neither can be split across services without splitting a
 * transaction.
 */
type CrossTableRepoMethods = {
  /**
   * Open a run, with Concurrency applied to the entity it is about.
   *
   * One serializable transaction, because the candidate read and the insert have
   * to be one decision: two reschedules arriving together otherwise both read an
   * empty in-flight set and both start. PostgreSQL detects that predicate conflict
   * and aborts one decision, which this method retries. `unlimited` compares
   * nothing, so it inserts straight away.
   *
   * Idempotent per arrival: a row this delivery already opened is answered with
   * rather than joined by a second, because the caller is an Inngest step whose
   * retry re-runs this whole call.
   *
   * The Inngest sends stay outside: this answers what the rows now say, and the
   * caller tells the bus about it.
   */
  readonly startForEntity: (input: {
    /**
     * The row to open. Its `entityValue` is what Concurrency serializes on as
     * well as what the column stores, and a start with nothing to serialize on
     * leaves it out.
     */
    execution: NewExecution;
    concurrency: Concurrency;
    /** Written onto a displaced run's `error`, which run history shows. */
    supersededReason: string;
  }) => Effect.Effect<EntityStartOutcome, DatabaseError>;
  /**
   * Erase one workflow's run history, answering how many runs went. Node logs
   * and wait states follow the runs by cascade; the audit rows are deleted here
   * beside them, in the same transaction, because half a deletion leaves rows
   * pointing at a run that is gone.
   */
  readonly deleteAllForWorkflow: (
    workflowId: string
  ) => Effect.Effect<number, DatabaseError>;
};

/**
 * Every database question the workflow services ask about runs: the executions
 * themselves, the per-node logs beside them, and the audit events.
 *
 * Separate from `WorkflowRepo` because these are a different aggregate with a
 * different lifetime: a workflow is edited, its runs accumulate and are swept.
 * The four polling endpoints the editor keeps open ask only through here.
 *
 * The shape is assembled from four slices, one file each beside this one
 * (`runs.ts`, `node-logs.ts`, `waits.ts`, `audit.ts`), plus the two cross-table
 * methods above that only this file can implement.
 */
export class ExecutionRepo extends Context.Service<
  ExecutionRepo,
  RunsRepoMethods &
    NodeLogsRepoMethods &
    WaitsRepoMethods &
    AuditRepoMethods &
    CrossTableRepoMethods
>()("@wfgraph/core/ExecutionRepo") {}

export const ExecutionRepoLayer: Layer.Layer<ExecutionRepo, never, Database> =
  Layer.effect(
    ExecutionRepo,
    Effect.gen(function* () {
      const database = yield* Database;

      return {
        ...makeRunsMethods(database),
        ...makeNodeLogsMethods(database),
        ...makeWaitsMethods(database),
        ...makeAuditMethods(database),

        startForEntity: ({ execution, concurrency, supersededReason }) =>
          database
            .query(async (db) => {
              const { entityValue } = execution;

              const findByDelivery = async (
                tx: WfGraphDatabase | WfGraphTransaction
              ) => {
                if (!execution.deliveryId) {
                  return undefined;
                }

                return await tx.query.workflowExecutions.findFirst({
                  where: {
                    workflowId: execution.workflowId,
                    deliveryId: execution.deliveryId,
                  },
                });
              };

              // Whatever status the arrival's own row is in, it is the answer:
              // the run may have finished while the step was being retried, and
              // opening a second one would run the graph twice for one Event.
              const insertRunning = async (
                tx: WfGraphDatabase | WfGraphTransaction
              ) => {
                const [row] = await tx
                  .insert(workflowExecutions)
                  .values({
                    workflowId: execution.workflowId,
                    workflowVersionId: execution.workflowVersionId,
                    status: "running",
                    startSource: execution.startSource,
                    runMode: execution.runMode,
                    startEventName: execution.startEventName,
                    entityValue: execution.entityValue,
                    deliveryId: execution.deliveryId,
                    input: execution.input,
                  })
                  .onConflictDoNothing({
                    target: [
                      workflowExecutions.workflowId,
                      workflowExecutions.deliveryId,
                    ],
                  })
                  .returning();

                // The conflict fires when two attempts at one arrival reach here
                // together. `unlimited` has no entity decision to serialize, so
                // the delivery constraint is its idempotency boundary.
                return row ?? (await findByDelivery(tx));
              };

              if (concurrency === "unlimited" || !entityValue) {
                const opened = await insertRunning(db);
                return {
                  status: "started" as const,
                  execution: opened,
                  supersededExecutionIds: [],
                  reclaimedExecutionIds: [],
                };
              }

              return await db.transaction(
                async (tx) => {
                  // Asked before Concurrency is, because this arrival's own row is
                  // not a run to defer to or displace. It is this call's answer.
                  const own = await findByDelivery(tx);
                  if (own) {
                    return {
                      status: "started" as const,
                      execution: own,
                      supersededExecutionIds: [],
                      reclaimedExecutionIds: [],
                    };
                  }

                  const inFlight = await tx
                    .select({
                      id: workflowExecutions.id,
                      enqueuedAt: workflowExecutions.enqueuedAt,
                      startedAt: workflowExecutions.startedAt,
                    })
                    .from(workflowExecutions)
                    .where(
                      and(
                        eq(workflowExecutions.workflowId, execution.workflowId),
                        eq(workflowExecutions.entityValue, entityValue),
                        eq(workflowExecutions.runMode, execution.runMode),
                        inArray(workflowExecutions.status, [
                          ...IN_FLIGHT_EXECUTION_STATUSES,
                        ])
                      )
                    );

                  let reclaimedExecutionIds: string[] = [];

                  if (inFlight.length > 0 && concurrency === "first-wins") {
                    const [unsent, live] = partition(inFlight, (row) =>
                      isStuckBeforeTheBus(row)
                    );

                    if (live.length > 0) {
                      return {
                        status: "refused" as const,
                        inFlightExecutionIds: live.map((row) => row.id),
                      };
                    }

                    reclaimedExecutionIds = await reclaimStuckRuns(
                      tx,
                      unsent.map((row) => row.id)
                    );
                  }

                  let supersededExecutionIds: string[] = [];

                  // Newest-wins only. First-wins either deferred to the runs it
                  // found or reclaimed them above, and displaces nothing.
                  if (inFlight.length > 0 && concurrency !== "first-wins") {
                    const ids = inFlight.map((row) => row.id);
                    const now = new Date();

                    const superseded = await tx
                      .update(workflowExecutions)
                      .set({
                        status: "superseded",
                        waitingAt: null,
                        completedAt: now,
                        error: supersededReason,
                      })
                      .where(
                        and(
                          inArray(workflowExecutions.id, ids),
                          inArray(workflowExecutions.status, [
                            ...IN_FLIGHT_EXECUTION_STATUSES,
                          ])
                        )
                      )
                      .returning({ id: workflowExecutions.id });

                    supersededExecutionIds = superseded.map((row) => row.id);

                    if (supersededExecutionIds.length > 0) {
                      await tx
                        .update(workflowWaitStates)
                        .set({ status: "cancelled", cancelledAt: now })
                        .where(
                          and(
                            inArray(
                              workflowWaitStates.executionId,
                              supersededExecutionIds
                            ),
                            eq(workflowWaitStates.status, "waiting")
                          )
                        );
                    }
                  }

                  return {
                    status: "started" as const,
                    execution: await insertRunning(tx),
                    supersededExecutionIds,
                    reclaimedExecutionIds,
                  };
                },
                { isolationLevel: "serializable" }
              );
            })
            .pipe(
              Effect.retry({
                schedule: serializationRetrySchedule,
                while: isSerializationFailure,
              })
            ),

        deleteAllForWorkflow: (workflowId) =>
          database.query(
            async (db) =>
              // One transaction, because the two deletes only make sense together:
              // a failure between them would leave audit rows pointing at a run
              // that is gone.
              //
              // The audit rows go by workflow rather than by run, which is what
              // makes "all runs deleted" true: a Refused Start has no run to be
              // found through, and a workflow with nothing but refusals has an
              // empty execution list and history to clear all the same.
              //
              // Node logs and wait states are not named here: both foreign keys
              // are `ON DELETE cascade`, so Postgres takes them with the runs. The
              // count comes off the delete rather than from a pre-read of ids,
              // which would bind one parameter per run and stop working past the
              // protocol's 65535.
              await db.transaction(async (tx) => {
                await tx
                  .delete(workflowExecutionEvents)
                  .where(eq(workflowExecutionEvents.workflowId, workflowId));

                const deleted = await tx
                  .delete(workflowExecutions)
                  .where(eq(workflowExecutions.workflowId, workflowId));

                return deleted.count;
              })
          ),
      };
    })
  );
