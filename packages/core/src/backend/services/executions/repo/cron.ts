/**
 * The PostgreSQL cron timer slice of `ExecutionRepo`. Lock order: workflow row,
 * timer rows by id, run schedule rows, execution rows. Publish, pause, resume
 * and `deleteById` take them in that order. A fire locks its timer, and its run
 * insert then key-shares the workflow row, which their no-key locks allow.
 * `deleteAllForWorkflow` and the retention sweeps start at run schedule rows.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { workflowExecutionSchedule } from "#src/backend/lib/db/schema";
import type {
  WfGraphDatabase,
  WfGraphTransaction,
} from "#src/backend/lib/db/index";
import type {
  Database,
  DatabaseError,
  LeaseLost,
} from "#src/backend/lib/effect/database";
import type { CronSchedule } from "@wfgraph/shared/lifecycle/cron-schedule";
import { admitStart } from "#src/backend/services/executions/repo/admission";
import { recordAuditEventWrite } from "#src/backend/services/executions/repo/audit";
import {
  cronFireVerdict,
  cronSlotAt,
  cronTimerChanges,
  type CronTimerRow,
  cronWakeAfter,
} from "#src/backend/services/executions/repo/cron-policy";
import {
  writeFenced,
  writeFencedSerializable,
} from "#src/backend/services/executions/repo/schedule";
import type {
  CronFence,
  CronFire,
  CronRefusedEntry,
  ExecutionSchedule,
  FireCronTimerInput,
} from "#src/backend/services/executions/repo/contracts";

type Executor = WfGraphDatabase | WfGraphTransaction;

/** What `skipCronSlot` did: the slot it skipped, and the timer's next wake. */
export type SkippedCronSlot = { slot: Date; nextWakeAt: Date };

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
export async function insertCronTimers(
  tx: Executor,
  input: {
    workflowId: string;
    schedules: readonly CronSchedule[];
    now: Date;
  }
): Promise<void> {
  if (input.schedules.length === 0) return;
  await tx.insert(workflowExecutionSchedule).values(
    input.schedules.map((schedule) => ({
      kind: "cron" as const,
      workflowId: input.workflowId,
      cron: schedule.cron,
      timeZone: schedule.timeZone,
      state: "waiting" as const,
      wakeAt: cronWakeAfter(schedule, input.now),
    }))
  );
}

/**
 * Rewrites a workflow's timers to match `schedules`, in the transaction that
 * activates the version declaring them, as `cronTimerChanges` decides. The
 * caller has locked the workflow row and passes no schedules for a paused
 * workflow, which keeps no timers.
 */
export async function replaceCronTimers(
  tx: Executor,
  input: {
    workflowId: string;
    schedules: readonly CronSchedule[];
    now: Date;
  }
): Promise<void> {
  const held = await tx
    .select({
      id: workflowExecutionSchedule.id,
      cron: workflowExecutionSchedule.cron,
      timeZone: workflowExecutionSchedule.timeZone,
    })
    .from(workflowExecutionSchedule)
    .where(timersOf(input.workflowId))
    .orderBy(asc(workflowExecutionSchedule.id))
    .for("update");
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
    await tx
      .delete(workflowExecutionSchedule)
      .where(inArray(workflowExecutionSchedule.id, deleteIds));
  }
  await insertCronTimers(tx, { ...input, schedules: insert });
}

/** Deletes every timer of a workflow, as a pause does. */
export async function deleteCronTimers(
  tx: Executor,
  workflowId: string
): Promise<void> {
  await tx.delete(workflowExecutionSchedule).where(timersOf(workflowId));
}

/**
 * Locks every timer of a workflow, ordered by id, so a write that deletes the
 * workflow holds them, after the workflow row, before its cascade reaches them.
 */
export async function lockCronTimers(
  tx: Executor,
  workflowId: string
): Promise<void> {
  await tx
    .select({ id: workflowExecutionSchedule.id })
    .from(workflowExecutionSchedule)
    .where(timersOf(workflowId))
    .orderBy(asc(workflowExecutionSchedule.id))
    .for("update");
}

/** The cron timer slice of `ExecutionRepo`. */
export type CronRepoMethods = {
  /**
   * Fire the leased timer `input.fence` names, in one serializable
   * transaction that first takes the timer row for update under the fence,
   * so a pass that lost its lease writes nothing.
   *
   * It reads the workflow row and decides with `cronFireVerdict`. A fire that
   * may commit admits the run as `startForEntity` does, for the latest slot
   * at or before `input.now`, which it writes as the run's `scheduledFor`, with
   * the schedule as `scheduleCron` and `scheduleTimeZone`. A
   * first-wins refusal writes the Refused Start instead. Either way the timer
   * moves to its first slot after `input.now` and its lease is released, in
   * the same transaction, so each slot fires once.
   */
  readonly fireCronTimer: (
    input: FireCronTimerInput
  ) => Effect.Effect<CronFire, DatabaseError | LeaseLost>;
  /**
   * Skip the slot a fire at `now` would run, for a fire that cannot run: its
   * graph no longer passes the preflight, or its retries are spent. In one
   * transaction fenced on the lease, it writes `refusedEntry` for that slot as
   * a Refused Start, and moves the timer on to its first slot after `now`,
   * releasing its lease and recording `error`. Answers the slot it skipped
   * and the timer's next wake.
   */
  readonly skipCronSlot: (input: {
    fence: CronFence;
    schedule: CronSchedule;
    error: string;
    refusedEntry: CronRefusedEntry;
    now: Date;
  }) => Effect.Effect<SkippedCronSlot, DatabaseError | LeaseLost>;
  /** Every timer of a workflow, earliest `wake_at` first. */
  readonly listCronTimers: (
    workflowId: string
  ) => Effect.Effect<ExecutionSchedule[], DatabaseError>;
};

export function makeCronMethods(
  database: Database["Service"]
): CronRepoMethods {
  return {
    fireCronTimer: (input) =>
      writeFencedSerializable(
        database,
        input.fence,
        async (tx): Promise<CronFire> => {
          const thisTimer = eq(
            workflowExecutionSchedule.id,
            input.fence.scheduleId
          );
          const workflow = await tx.query.workflows.findFirst({
            where: { id: input.fence.workflowId },
            columns: { isPaused: true, publishedVersionId: true, mode: true },
          });
          // The timer row cascades with its workflow, and the fence found it.
          if (!workflow) {
            throw new Error("A leased timer's workflow is missing");
          }
          const verdict = cronFireVerdict(workflow, input);
          if (verdict !== "fire") {
            if (verdict.kind === "dropped") {
              await tx.delete(workflowExecutionSchedule).where(thisTimer);
            }
            return verdict;
          }

          const [timer] = await tx
            .select({ wakeAt: workflowExecutionSchedule.wakeAt })
            .from(workflowExecutionSchedule)
            .where(thisTimer);
          const slot = cronSlotAt(
            input.schedule,
            input.now,
            timer?.wakeAt ?? input.now
          );
          const nextWakeAt = cronWakeAfter(input.schedule, input.now);
          const start = await admitStart(tx, {
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
            await recordAuditEventWrite({
              workflowId: input.fence.workflowId,
              eventType: "run_refused",
              message: refused.message,
              metadata: {
                ...refused.metadata,
                inFlightExecutionIds: start.inFlightExecutionIds,
              },
            })(tx);
          }
          await tx
            .update(workflowExecutionSchedule)
            .set({ ...RELEASED_LEASE, wakeAt: nextWakeAt, lastError: null })
            .where(thisTimer);
          return { kind: "fired", slot, nextWakeAt, start };
        },
        "update"
      ),

    skipCronSlot: (input) =>
      writeFenced(
        database,
        input.fence,
        async (tx): Promise<SkippedCronSlot> => {
          const thisTimer = eq(
            workflowExecutionSchedule.id,
            input.fence.scheduleId
          );
          const [timer] = await tx
            .select({ wakeAt: workflowExecutionSchedule.wakeAt })
            .from(workflowExecutionSchedule)
            .where(thisTimer);
          const slot = cronSlotAt(
            input.schedule,
            input.now,
            timer?.wakeAt ?? input.now
          );
          const nextWakeAt = cronWakeAfter(input.schedule, input.now);
          const refused = input.refusedEntry(slot);
          await recordAuditEventWrite({
            workflowId: input.fence.workflowId,
            eventType: "run_refused",
            message: refused.message,
            metadata: refused.metadata,
          })(tx);
          await tx
            .update(workflowExecutionSchedule)
            .set({
              ...RELEASED_LEASE,
              wakeAt: nextWakeAt,
              lastError: input.error,
            })
            .where(thisTimer);
          return { slot, nextWakeAt };
        },
        "update"
      ),

    listCronTimers: (workflowId) =>
      database.query((db) =>
        db
          .select()
          .from(workflowExecutionSchedule)
          .where(timersOf(workflowId))
          .orderBy(
            asc(workflowExecutionSchedule.wakeAt),
            asc(workflowExecutionSchedule.id)
          )
      ),
  };
}
