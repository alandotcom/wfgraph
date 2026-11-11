import { Context, Effect, Layer } from "effect";
import { workflowExecutionEvents } from "#src/backend/lib/db/schema";
import {
  Database,
  type DatabaseError,
  serializableTransaction,
} from "#src/backend/lib/effect/database";
import type {
  EntityEligibilityReason,
  WorkflowExecutionIgnoredReason,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  admissionReads,
  admitStart,
  findAdmissionRefusal,
  findStartRefusal,
  openRun,
} from "#src/backend/services/executions/repo/admission";
import { lockEventStart } from "#src/backend/services/executions/repo/cancel-order";
import {
  type ClaimsRepoMethods,
  makeClaimsMethods,
} from "#src/backend/services/executions/repo/claims";
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
import {
  makePassWrites,
  makeScheduleMethods,
  type PassWrites,
  type ScheduleRepoMethods,
} from "#src/backend/services/executions/repo/schedule";
import {
  type InboxRepoMethods,
  makeInboxMethods,
} from "#src/backend/services/executions/repo/inbox";
import {
  type ExecutorStateRepoMethods,
  makeExecutorStateMethods,
} from "#src/backend/services/executions/repo/executor-state";
import {
  makeRetentionMethods,
  type RetentionRepoMethods,
} from "#src/backend/services/executions/repo/retention";
import {
  type CronRepoMethods,
  makeCronMethods,
} from "#src/backend/services/executions/repo/cron";
import { makeFencedWrites } from "#src/backend/services/executions/repo/fenced-writes";
import { deleteWorkflowHistory } from "#src/backend/services/executions/repo/history";
import type { FencedExecutionWrites } from "#src/backend/services/executions/repo/fencing";
import type {
  DeliveryFence,
  EntityStartOutcome,
  RunFence,
  StartAdmissionDecision,
  StartForEntityInput,
} from "#src/backend/services/executions/repo/contracts";
import type { JsonObject } from "@wfgraph/shared/types/json";

export * from "#src/backend/services/executions/repo/contracts";
export type {
  FencedExecutionWrites,
  StoreWrites,
} from "#src/backend/services/executions/repo/fencing";
export type {
  ParkWrites,
  PassWrites,
} from "#src/backend/services/executions/repo/schedule";
export type { CronPassWrites } from "#src/backend/services/executions/repo/cron";

/**
 * The methods that touch more than one table in one transaction, which is the
 * reason `ExecutionRepo` is one service rather than several: `startForEntity`
 * writes `workflow_executions`, `workflow_wait_states`, the new run's schedule
 * row and its timeline entry inside one serializable transaction,
 * `deleteAllForWorkflow` locks each batch's schedule rows and then its runs,
 * and every write `fenced` answers takes the run's schedule row in
 * the same transaction as the rows it writes. None can be split across
 * services without splitting a transaction.
 */
type CrossTableRepoMethods = {
  /**
   * Open a run, with Concurrency applied to the entity it is about, and
   * schedule it on the database executor.
   *
   * One serializable transaction, because the candidate read and the insert have
   * to be one decision: two reschedules arriving together otherwise both read an
   * empty in-flight set and both start. PostgreSQL detects that predicate conflict
   * and aborts one decision, which this method retries. `unlimited` compares
   * nothing, so it inserts straight away, in a transaction of its own.
   *
   * The new row's schedule row and its "run started" entry commit with it, as
   * `StartForEntityInput` describes, so no open run is ever left unscheduled.
   * The caller wakes the worker loops once this has committed.
   *
   * Idempotent per arrival: a row this delivery already opened is answered with
   * rather than joined by a second, because the delivery that calls it may be
   * retried, and a retry re-runs this whole call.
   */
  readonly startForEntity: (
    input: StartForEntityInput
  ) => Effect.Effect<EntityStartOutcome, DatabaseError>;
  /**
   * The start refusal one delivery recorded in one workflow, under
   * `startAdmissionDecisionId`, whatever refused it: a retried delivery
   * answers from it before it repeats a filter, a resolver or Concurrency.
   */
  readonly findAdmissionRefusal: (input: {
    workflowId: string;
    decisionId: string;
  }) => Effect.Effect<WorkflowExecutionIgnoredReason | null, DatabaseError>;
  /**
   * Atomically records a refusal or returns the start that won the delivery.
   * The refusal's metadata carries `deliveryId`, which keeps the row through
   * `sweepWorkflowAuditEvents` while that inbox row exists.
   */
  readonly recordAdmissionRefusal: (input: {
    workflowId: string;
    deliveryId: string;
    decisionId: string;
    reason: EntityEligibilityReason;
    message: string;
    metadata: JsonObject;
  }) => Effect.Effect<StartAdmissionDecision, DatabaseError>;
  /**
   * Erase one workflow's run history, answering how many runs this call
   * deleted: its runs, with the node logs, wait rows, schedule rows and
   * audit rows that follow each by cascade, and then the workflow's audit
   * rows naming no run. It deletes `SWEEP_BATCH` rows per transaction, so a
   * long history never holds its locks, or SQLite's one writer, for its whole
   * length. A call that stops partway has deleted whole runs, and calling it
   * again deletes the rest. Each batch locks its runs' schedule rows before
   * the runs, in the order every fenced write takes them.
   */
  readonly deleteAllForWorkflow: (
    workflowId: string
  ) => Effect.Effect<number, DatabaseError>;
  /**
   * The writes of one database executor pass, fenced on its owner token. See
   * `fenced-writes.ts`. A pass that has written its run's terminal record makes
   * the unfenced writes of the same names.
   */
  readonly fenced: (fence: RunFence) => FencedExecutionWrites;
  /**
   * The writes only a pass makes, fenced on the owner token of a pass over a
   * `delivery` row and on the row still naming the fence's inbox row. A
   * delivery makes no store writes of its own: the services its steps call
   * write unfenced, and its step memo row is what makes a step run once. A
   * pass over a `cron` row takes its writes from `fencedCron`.
   */
  readonly fencedPass: (fence: DeliveryFence) => PassWrites;
};

/**
 * Every database question the workflow services ask about runs: the executions
 * themselves, the per-node logs beside them, and the audit events.
 *
 * Separate from `WorkflowRepo` because these are a different aggregate with a
 * different lifetime: a workflow is edited, its runs accumulate and are swept.
 * The four polling endpoints the editor keeps open ask only through here.
 *
 * The shape is assembled from ten slices, one file each beside this one
 * (`runs.ts`, `node-logs.ts`, `waits.ts`, `audit.ts`, `schedule.ts` for the
 * database executor's schedule rows and step memo, `executor-state.ts` for
 * the Runs view's reads of them, `claims.ts` for the producers that claim a
 * run's parks, `inbox.ts` for the event inbox, `retention.ts` for the
 * run-history retention sweep, and `cron.ts` for cron schedule timers),
 * plus the cross-table methods above that only this file can implement. A
 * timer is a slice here because its fire admits a run in the transaction
 * fenced on the timer's lease, through the same `admission.ts` as
 * `startForEntity`. The event inbox is a slice here because a delivery is a
 * body on the same executor: its schedule row and step memo are this
 * aggregate's tables, and a settling delivery writes its inbox row and deletes
 * its schedule row in one transaction.
 */
export class ExecutionRepo extends Context.Service<
  ExecutionRepo,
  RunsRepoMethods &
    NodeLogsRepoMethods &
    WaitsRepoMethods &
    AuditRepoMethods &
    ScheduleRepoMethods &
    ExecutorStateRepoMethods &
    ClaimsRepoMethods &
    InboxRepoMethods &
    RetentionRepoMethods &
    CronRepoMethods &
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
        ...makeScheduleMethods(database),
        ...makeExecutorStateMethods(database),
        ...makeClaimsMethods(database),
        ...makeInboxMethods(database),
        ...makeRetentionMethods(database),
        ...makeCronMethods(database),
        fenced: makeFencedWrites(database),
        fencedPass: (fence) => makePassWrites(database, fence),

        startForEntity: (input) =>
          admissionReads(input)
            ? serializableTransaction(database, (tx) => admitStart(tx, input))
            : database.query((db) =>
                db.transaction(async (tx) => {
                  await lockEventStart(tx, input.execution, "read committed");
                  return await openRun(tx, input);
                })
              ),

        findAdmissionRefusal: (input) =>
          database.query((db) => findStartRefusal(db, input)),

        recordAdmissionRefusal: (input) =>
          serializableTransaction(
            database,
            async (tx): Promise<StartAdmissionDecision> => {
              const existingExecution =
                await tx.query.workflowExecutions.findFirst({
                  where: {
                    workflowId: input.workflowId,
                    deliveryId: input.deliveryId,
                  },
                  columns: { id: true },
                });
              if (existingExecution) {
                return {
                  kind: "started" as const,
                  executionId: existingExecution.id,
                };
              }

              const existingRefusal = await findAdmissionRefusal(tx, {
                workflowId: input.workflowId,
                decisionId: input.decisionId,
              });
              if (existingRefusal) {
                return {
                  kind: "refused" as const,
                  reason: existingRefusal,
                };
              }

              await tx.insert(workflowExecutionEvents).values({
                id: input.decisionId,
                workflowId: input.workflowId,
                eventType: "run_refused",
                message: input.message,
                metadata: { ...input.metadata, deliveryId: input.deliveryId },
              });
              return { kind: "refused" as const, reason: input.reason };
            }
          ),

        deleteAllForWorkflow: (workflowId) =>
          database.query((db) => deleteWorkflowHistory(db, workflowId)),
      };
    })
  );
