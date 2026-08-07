import { and, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
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
import { Database, type DatabaseError } from "#src/backend/lib/effect/database";
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
 * writes `workflow_executions` and `workflow_wait_states` inside one advisory
 * lock, and `deleteAllForWorkflow` deletes the runs and the workflow-scoped audit
 * rows together. Neither can be split across services without splitting a
 * transaction.
 */
type CrossTableRepoMethods = {
  /**
   * Open a run, with Concurrency applied to the entity it is about.
   *
   * One transaction holding an advisory lock on the workflow and Entity Value,
   * because the candidate read and the insert have to be one decision: two
   * reschedules arriving together otherwise both read an empty in-flight set
   * and both start, which the compare-and-set on the displaced rows cannot
   * catch. `unlimited` compares nothing, so it takes no lock and inserts
   * straight away.
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
          database.query(async (db) => {
            const { entityValue } = execution;

            const findByDelivery = async (
              tx: WfGraphDatabase | WfGraphTransaction
            ) => {
              if (!execution.deliveryId) {
                return undefined;
              }

              return await tx.query.workflowExecutions.findFirst({
                where: and(
                  eq(workflowExecutions.workflowId, execution.workflowId),
                  eq(workflowExecutions.deliveryId, execution.deliveryId)
                ),
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
              // together, which the advisory lock cannot serialize because
              // `unlimited` takes none.
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

            return await db.transaction(async (tx) => {
              // Serialized per workflow and entity, and only against other
              // starts: nothing else in WfGraph takes a lock in this name space, so a
              // run's own writes never wait here. The two-key form keeps the
              // workflow and the entity in separate hashes, so no pair of values
              // can join into another pair's key. Two entities whose hashes
              // collide serialize against each other, which costs a wait and
              // decides nothing.
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${`wfgraph:entity:${execution.workflowId}`}), hashtext(${entityValue}))`
              );

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
            });
          }),

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
