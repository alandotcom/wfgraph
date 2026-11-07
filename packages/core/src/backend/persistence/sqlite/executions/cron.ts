/**
 * The cron timer slice of the SQLite `ExecutionRepo`, and the timer writes
 * Publish and pause make inside their own write transactions, as the
 * PostgreSQL backend's `repo/cron.ts` describes them. `cron-policy.ts` makes
 * the decisions. Every write here runs in one `BEGIN IMMEDIATE` transaction
 * holding the one writer, so a fire, a Publish and a pause never interleave.
 */

import { Effect } from "effect";
import { and, asc, eq, inArray } from "drizzle-orm";
import { generateId } from "@wfgraph/shared/utils/id";
import type { CronSchedule } from "@wfgraph/shared/lifecycle/cron-schedule";
import type { CronRepoMethods } from "#src/backend/services/executions/repo/cron";
import type {
  CronFire,
  CronSkip,
} from "#src/backend/services/executions/repo/contracts";
import {
  cronFireVerdict,
  type CronFireWorkflow,
  cronPublicationVerdict,
  cronSlotAt,
  cronTimerChanges,
  type CronTimerRow,
  cronWakeAfter,
} from "#src/backend/services/executions/repo/cron-policy";
import type {
  SqliteDatabase,
  SqliteExecutor,
} from "#src/backend/persistence/sqlite/database";
import {
  workflowExecutionSchedule,
  workflows,
} from "#src/backend/persistence/sqlite/schema";
import { admitStart } from "#src/backend/persistence/sqlite/executions/admission";
import { recordAuditEventWrite } from "#src/backend/persistence/sqlite/executions/audit";
import { writeFenced } from "#src/backend/persistence/sqlite/executions/schedule";
import { sqliteExecutionSchedule } from "#src/backend/persistence/sqlite/executions/rows";
import {
  workflowIsPaused,
  workflowMode,
} from "#src/backend/persistence/sqlite/workflows/rows";

/** A workflow's timer rows. */
function timersOf(workflowId: string) {
  return and(
    eq(workflowExecutionSchedule.kind, "cron"),
    eq(workflowExecutionSchedule.workflowId, workflowId)
  );
}

/** The lease columns a fire or a skipped slot clears as it moves the timer on. */
const RELEASED_LEASE = {
  state: "waiting",
  attempt: 0,
  runningStepId: null,
  runningNodeId: null,
  leaseExpiresAt: null,
  ownerToken: null,
  workerId: null,
} as const;

/**
 * Writes one timer per schedule of `workflowId`, each `waiting` and due at the
 * schedule's first slot after `now`, with no lease.
 */
function insertCronTimers(
  database: SqliteExecutor,
  input: {
    workflowId: string;
    schedules: readonly CronSchedule[];
    now: Date;
  }
) {
  if (input.schedules.length === 0) return Effect.void;
  return database.insert(workflowExecutionSchedule).values(
    input.schedules.map((schedule) => ({
      id: generateId(),
      kind: "cron",
      workflowId: input.workflowId,
      cron: schedule.cron,
      timeZone: schedule.timeZone,
      state: "waiting",
      wakeAt: cronWakeAfter(schedule, input.now).getTime(),
    }))
  );
}

/**
 * Rewrites a workflow's timers to match `schedules`, in the write transaction
 * that activates the version declaring them, as `cronTimerChanges` decides.
 * The caller passes no schedules for a paused workflow, which keeps no timers.
 */
export function replaceCronTimers(
  database: SqliteExecutor,
  input: {
    workflowId: string;
    schedules: readonly CronSchedule[];
    now: Date;
  }
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const held = yield* database
      .select({
        id: workflowExecutionSchedule.id,
        cron: workflowExecutionSchedule.cron,
        timeZone: workflowExecutionSchedule.timeZone,
      })
      .from(workflowExecutionSchedule)
      .where(timersOf(input.workflowId));
    const rows = held.flatMap((row): CronTimerRow[] =>
      row.cron === null || row.timeZone === null
        ? []
        : [{ id: row.id, cron: row.cron, timeZone: row.timeZone }]
    );
    const { deleteIds, insert } = cronTimerChanges({
      rows,
      schedules: input.schedules,
    });
    if (deleteIds.length > 0) {
      yield* database
        .delete(workflowExecutionSchedule)
        .where(inArray(workflowExecutionSchedule.id, deleteIds));
    }
    yield* insertCronTimers(database, { ...input, schedules: insert });
  });
}

/** Deletes every timer of a workflow, as a pause does. */
export function deleteCronTimers(database: SqliteExecutor, workflowId: string) {
  return database.delete(workflowExecutionSchedule).where(timersOf(workflowId));
}

/**
 * The workflow row a fenced timer write decides from. The timer row cascades
 * with its workflow, and the fence found the timer, so the workflow exists.
 */
function timerWorkflow(database: SqliteExecutor, workflowId: string) {
  return database
    .select({
      isPaused: workflows.isPaused,
      publishedVersionId: workflows.publishedVersionId,
      mode: workflows.mode,
    })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .get()
    .pipe(
      Effect.map((workflow): CronFireWorkflow => {
        if (!workflow) {
          throw new Error("A leased timer's workflow is missing");
        }
        return {
          isPaused: workflowIsPaused(workflow.isPaused),
          publishedVersionId: workflow.publishedVersionId,
          mode: workflowMode(workflow.mode),
        };
      })
    );
}

export function makeSqliteCronMethods(store: SqliteDatabase): CronRepoMethods {
  return {
    fireCronTimer: (input) =>
      writeFenced(store, input.fence, (database) =>
        Effect.gen(function* () {
          const thisTimer = eq(
            workflowExecutionSchedule.id,
            input.fence.scheduleId
          );
          const verdict = cronFireVerdict(
            yield* timerWorkflow(database, input.fence.workflowId),
            input
          );
          if (verdict !== "fire") {
            if (verdict.kind === "dropped") {
              yield* database
                .delete(workflowExecutionSchedule)
                .where(thisTimer);
            }
            return verdict;
          }

          const timer = yield* database
            .select({ wakeAt: workflowExecutionSchedule.wakeAt })
            .from(workflowExecutionSchedule)
            .where(thisTimer)
            .get();
          const slot = cronSlotAt(
            input.schedule,
            input.now,
            timer === undefined ? input.now : new Date(timer.wakeAt)
          );
          const nextWakeAt = cronWakeAfter(input.schedule, input.now);
          const start = yield* admitStart(database, {
            ...input.start,
            execution: {
              ...input.start.execution,
              scheduled: { slot, schedule: input.schedule },
            },
            now: input.now,
          });
          if (start.status === "admission_refused") {
            throw new Error(
              "A scheduled start met an Entity admission refusal"
            );
          }
          if (start.status === "refused") {
            const refused = input.refusedEntry(slot);
            yield* recordAuditEventWrite({
              workflowId: input.fence.workflowId,
              eventType: "run_refused",
              message: refused.message,
              metadata: {
                ...refused.metadata,
                inFlightExecutionIds: start.inFlightExecutionIds,
              },
            })(database);
          }
          yield* database
            .update(workflowExecutionSchedule)
            .set({
              ...RELEASED_LEASE,
              wakeAt: nextWakeAt.getTime(),
              lastError: null,
            })
            .where(thisTimer);
          const fired: CronFire = { kind: "fired", slot, nextWakeAt, start };
          return fired;
        })
      ),

    skipCronSlot: (input) =>
      writeFenced(store, input.fence, (database) =>
        Effect.gen(function* () {
          const thisTimer = eq(
            workflowExecutionSchedule.id,
            input.fence.scheduleId
          );
          if (input.expected !== undefined) {
            const verdict = cronPublicationVerdict(
              yield* timerWorkflow(database, input.fence.workflowId),
              input.expected
            );
            if (verdict !== "current") {
              if (verdict.kind === "dropped") {
                yield* database
                  .delete(workflowExecutionSchedule)
                  .where(thisTimer);
              }
              return verdict;
            }
          }
          const timer = yield* database
            .select({ wakeAt: workflowExecutionSchedule.wakeAt })
            .from(workflowExecutionSchedule)
            .where(thisTimer)
            .get();
          const slot = cronSlotAt(
            input.schedule,
            input.now,
            timer === undefined ? input.now : new Date(timer.wakeAt)
          );
          const nextWakeAt = cronWakeAfter(input.schedule, input.now);
          const refused = input.refusedEntry(slot);
          yield* recordAuditEventWrite({
            workflowId: input.fence.workflowId,
            eventType: "run_refused",
            message: refused.message,
            metadata: refused.metadata,
          })(database);
          yield* database
            .update(workflowExecutionSchedule)
            .set({
              ...RELEASED_LEASE,
              wakeAt: nextWakeAt.getTime(),
              lastError: input.error,
            })
            .where(thisTimer);
          const skipped: CronSkip = { kind: "skipped", slot, nextWakeAt };
          return skipped;
        })
      ),

    listCronTimers: (workflowId) =>
      store.read((database) =>
        database
          .select()
          .from(workflowExecutionSchedule)
          .where(timersOf(workflowId))
          .orderBy(
            asc(workflowExecutionSchedule.wakeAt),
            asc(workflowExecutionSchedule.id)
          )
          .pipe(Effect.map((rows) => rows.map(sqliteExecutionSchedule)))
      ),
  };
}
