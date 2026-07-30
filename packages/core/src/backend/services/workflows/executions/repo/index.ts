import { and, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { RovaDatabase, RovaTransaction } from "#src/backend/lib/db/index";
import { Database, type DatabaseError } from "#src/backend/lib/effect/database";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@rova/shared/workflow/execution-contracts";
import type { Concurrency } from "@rova/shared/workflow/lifecycle-rules";
import {
  type AuditRepoMethods,
  makeAuditMethods,
} from "#src/backend/services/workflows/executions/repo/audit";
import {
  type NodeLogsRepoMethods,
  makeNodeLogsMethods,
} from "#src/backend/services/workflows/executions/repo/node-logs";
import {
  makeRunsMethods,
  type RunsRepoMethods,
} from "#src/backend/services/workflows/executions/repo/runs";
import {
  makeWaitsMethods,
  type WaitsRepoMethods,
} from "#src/backend/services/workflows/executions/repo/waits";
import type {
  EntityStartOutcome,
  NewExecution,
} from "#src/backend/services/workflows/executions/repo/contracts";

export * from "#src/backend/services/workflows/executions/repo/contracts";

/**
 * The two methods that touch more than one table in one transaction, which is
 * the reason `ExecutionRepo` is one service rather than four: `startForEntity`
 * writes `workflow_executions` and `workflow_wait_states` inside one advisory
 * lock, and `deleteAllForWorkflow` deletes across all four tables it owns.
 * Neither can be split across services without splitting a transaction.
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
   * The Inngest sends stay outside: this answers what the rows now say, and the
   * caller tells the bus about it.
   */
  readonly startForEntity: (input: {
    execution: NewExecution;
    concurrency: Concurrency;
    /** Absent for a start with nothing to serialize on. */
    entityValue?: string;
    /** Written onto a displaced run's `error`, which run history shows. */
    supersededReason: string;
  }) => Effect.Effect<EntityStartOutcome, DatabaseError>;
  /**
   * Erase one workflow's run history, answering how many runs went. Logs, wait
   * states, and events go with them, which is why this is one method rather
   * than four: half a deletion leaves rows pointing at a run that is gone.
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
>()("ExecutionRepo") {}

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

        startForEntity: ({
          execution,
          concurrency,
          entityValue,
          supersededReason,
        }) =>
          database.query(async (db) => {
            const insertRunning = async (
              tx: RovaDatabase | RovaTransaction
            ) => {
              const [row] = await tx
                .insert(workflowExecutions)
                .values({
                  workflowId: execution.workflowId,
                  status: "running",
                  startSource: execution.startSource,
                  runMode: execution.runMode,
                  triggerEventType: execution.triggerEventType,
                  correlationKey: execution.correlationKey,
                  input: execution.input,
                })
                .returning();

              return row;
            };

            if (concurrency === "unlimited" || !entityValue) {
              return {
                status: "started" as const,
                execution: await insertRunning(db),
                supersededExecutionIds: [],
              };
            }

            return await db.transaction(async (tx) => {
              // Serialized per workflow and entity, and only against other
              // starts: nothing else in Rova takes a lock in this name space, so a
              // run's own writes never wait here. The two-key form keeps the
              // workflow and the entity in separate hashes, so no pair of values
              // can join into another pair's key. Two entities whose hashes
              // collide serialize against each other, which costs a wait and
              // decides nothing.
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${`rova:entity:${execution.workflowId}`}), hashtext(${entityValue}))`
              );

              const inFlight = await tx
                .select({ id: workflowExecutions.id })
                .from(workflowExecutions)
                .where(
                  and(
                    eq(workflowExecutions.workflowId, execution.workflowId),
                    eq(workflowExecutions.correlationKey, entityValue),
                    eq(workflowExecutions.runMode, execution.runMode),
                    inArray(workflowExecutions.status, [
                      ...IN_FLIGHT_EXECUTION_STATUSES,
                    ])
                  )
                );

              if (inFlight.length > 0 && concurrency === "first-wins") {
                return {
                  status: "refused" as const,
                  inFlightExecutionIds: inFlight.map((row) => row.id),
                };
              }

              let supersededExecutionIds: string[] = [];

              if (inFlight.length > 0) {
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
              };
            });
          }),

        deleteAllForWorkflow: (workflowId) =>
          database.query(async (db) => {
            const executions = await db.query.workflowExecutions.findMany({
              where: eq(workflowExecutions.workflowId, workflowId),
              columns: { id: true },
            });

            const executionIds = executions.map((execution) => execution.id);

            // One transaction, because the deletes only make sense together: a
            // failure between them would leave logs, wait states, or audit rows
            // pointing at a run that is gone.
            //
            // The audit rows go by workflow rather than by run, which is what
            // makes "all runs deleted" true: a Refused Start has no run to be
            // found through, and a workflow with nothing but refusals has an
            // empty execution list and history to clear all the same.
            await db.transaction(async (tx) => {
              if (executionIds.length > 0) {
                await tx
                  .delete(workflowExecutionLogs)
                  .where(
                    inArray(workflowExecutionLogs.executionId, executionIds)
                  );

                await tx
                  .delete(workflowWaitStates)
                  .where(inArray(workflowWaitStates.executionId, executionIds));
              }

              await tx
                .delete(workflowExecutionEvents)
                .where(eq(workflowExecutionEvents.workflowId, workflowId));

              await tx
                .delete(workflowExecutions)
                .where(eq(workflowExecutions.workflowId, workflowId));
            });

            return executionIds.length;
          }),
      };
    })
  );
