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
import type {
  CronPassWrites,
  CronRepoMethods,
} from "#src/backend/services/executions/repo/cron";
import type {
  CronFence,
  CronFire,
  CronSkip,
} from "#src/backend/services/executions/repo/contracts";
import {
  cronFireVerdict,
  type CronFireWorkflow,
  cronPublicationVerdict,
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
import { admitWithConcurrency } from "#src/backend/persistence/sqlite/executions/admission";
import { recordAuditEventWrite } from "#src/backend/persistence/sqlite/executions/audit";
import {
  makeSqlitePassWrites,
  writeFenced,
} from "#src/backend/persistence/sqlite/executions/schedule";
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

/** Builds the writes of one pass over a `cron` row, fenced on `fence`. */
function makeSqliteCronPassWrites(
  store: SqliteDatabase,
  fence: CronFence
): CronPassWrites {
  const thisTimer = eq(workflowExecutionSchedule.id, fence.scheduleId);
  return {
    ...makeSqlitePassWrites(store, fence),

    fireCronTimer: (input) =>
      writeFenced(store, fence, (database) =>
        Effect.gen(function* () {
          const verdict = cronFireVerdict(
            yield* timerWorkflow(database, fence.workflowId),
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

          const start = yield* admitWithConcurrency(database, {
            ...input.start,
            execution: {
              ...input.start.execution,
              scheduled: { slot: input.slot, schedule: input.schedule },
            },
            now: input.now,
          });
          if (start.status === "refused") {
            yield* recordAuditEventWrite({
              workflowId: fence.workflowId,
              eventType: "run_refused",
              message: input.refusedEntry.message,
              metadata: {
                ...input.refusedEntry.metadata,
                inFlightExecutionIds: start.inFlightExecutionIds,
              },
            })(database);
          }
          yield* database
            .update(workflowExecutionSchedule)
            .set({
              ...RELEASED_LEASE,
              wakeAt: input.nextWakeAt.getTime(),
              lastError: null,
            })
            .where(thisTimer);
          const fired: CronFire = { kind: "fired", start };
          return fired;
        })
      ),

    skipCronSlot: (input) =>
      writeFenced(store, fence, (database) =>
        Effect.gen(function* () {
          if (input.expected !== undefined) {
            const verdict = cronPublicationVerdict(
              yield* timerWorkflow(database, fence.workflowId),
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
          yield* recordAuditEventWrite({
            workflowId: fence.workflowId,
            eventType: "run_refused",
            message: input.refusedEntry.message,
            metadata: input.refusedEntry.metadata,
          })(database);
          yield* database
            .update(workflowExecutionSchedule)
            .set({
              ...RELEASED_LEASE,
              wakeAt: input.nextWakeAt.getTime(),
              lastError: input.error,
            })
            .where(thisTimer);
          const skipped: CronSkip = { kind: "skipped" };
          return skipped;
        })
      ),
  };
}

export function makeSqliteCronMethods(store: SqliteDatabase): CronRepoMethods {
  return {
    fencedCron: (fence) => makeSqliteCronPassWrites(store, fence),

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
