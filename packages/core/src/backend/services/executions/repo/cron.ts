/**
 * The PostgreSQL cron timer slice of `ExecutionRepo`. Lock order: workflow row,
 * timer rows by id, run schedule rows, execution rows. Publish, pause, resume
 * and `deleteById` take them in that order. A fire locks its timer, and its run
 * insert then key-shares the workflow row, which their no-key locks allow.
 * `deleteAllForWorkflow` and the retention sweeps start at run schedule rows.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
import { admitWithConcurrency } from "#src/backend/services/executions/repo/admission";
import { recordAuditEventWrite } from "#src/backend/services/executions/repo/audit";
import {
  cronFireVerdict,
  type CronFireWorkflow,
  cronPublicationVerdict,
  cronTimerChanges,
  type CronTimerRow,
  cronWakeAfter,
} from "#src/backend/services/executions/repo/cron-policy";
import { CLEARED_LEASE } from "#src/backend/services/executions/repo/release-policy";
import {
  makePassWrites,
  type PassWrites,
  writeFenced,
  writeFencedSerializable,
} from "#src/backend/services/executions/repo/schedule";
import type {
  CronFence,
  CronFire,
  CronSkip,
  FireCronTimerInput,
  SkipCronSlotInput,
} from "#src/backend/services/executions/repo/contracts";

type Executor = WfGraphDatabase | WfGraphTransaction;

/** A workflow's timer rows. */
function timersOf(workflowId: string) {
  return and(
    eq(workflowExecutionSchedule.kind, "cron"),
    eq(workflowExecutionSchedule.workflowId, workflowId)
  );
}

/** The columns a fire or a skipped slot resets as it moves the timer on. */
const RELEASED_LEASE = {
  state: "waiting",
  attempt: 0,
  ...CLEARED_LEASE,
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
 *
 * A kept row is rewritten with its own `wake_at`, which changes nothing in it
 * but makes it a row this transaction updated. A fire is serializable and
 * locks its timer first, so a fire whose snapshot predates this Publish and
 * that waited for the lock fails with 40001 when this commits, and retries on
 * a snapshot that reads the version this Publish activated. A row that was
 * only locked would let the fire read the version this Publish replaced.
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
  const { keepIds, deleteIds, insert } = cronTimerChanges({
    rows,
    schedules: input.schedules,
  });
  if (keepIds.length > 0) {
    await tx
      .update(workflowExecutionSchedule)
      .set({ wakeAt: sql`${workflowExecutionSchedule.wakeAt}` })
      .where(inArray(workflowExecutionSchedule.id, keepIds));
  }
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

/**
 * The workflow row a fenced timer write decides from. The timer row cascades
 * with its workflow, and the fence found the timer, so the workflow exists.
 */
async function timerWorkflow(
  tx: Executor,
  workflowId: string
): Promise<CronFireWorkflow> {
  const workflow = await tx.query.workflows.findFirst({
    where: { id: workflowId },
    columns: { isPaused: true, publishedVersionId: true, mode: true },
  });
  if (!workflow) {
    throw new Error("A leased timer's workflow is missing");
  }
  return workflow;
}

/**
 * The writes a pass over a `cron` row makes: the writes every pass makes,
 * beside the fire and the skip, each fenced on the pass's `CronFence`.
 */
export type CronPassWrites = PassWrites & {
  /**
   * Fire the pass's leased timer, in one serializable transaction that first
   * takes the timer row for update under the fence, so a pass that lost its
   * lease writes nothing.
   *
   * It reads the workflow row and decides with `cronFireVerdict`. A fire that
   * may proceed admits the run as `startForEntity` does, writing `input.slot`
   * as the run's `scheduledFor`, with the schedule as `scheduleCron` and
   * `scheduleTimeZone`. A first-wins refusal writes the Refused Start instead.
   * Either way the timer moves to `input.nextWakeAt` and its lease is
   * released, in the same transaction, so each slot fires once.
   */
  readonly fireCronTimer: (
    input: FireCronTimerInput
  ) => Effect.Effect<CronFire, DatabaseError | LeaseLost>;
  /**
   * Skip the slot a fire cannot run: its graph no longer passes the
   * preflight, or its retries are spent. In one transaction fenced on the
   * lease, it writes `refusedEntry` as a Refused Start, and moves the timer
   * to `nextWakeAt`, releasing its lease and recording `error`.
   *
   * With `expected`, the publication the preflight checked, it first reads
   * the workflow row and decides with `cronPublicationVerdict`, writing
   * nothing for a stale publication and deleting the timer for a dropped one,
   * as `fireCronTimer` does. A skip after spent retries passes none.
   */
  readonly skipCronSlot: (
    input: SkipCronSlotInput
  ) => Effect.Effect<CronSkip, DatabaseError | LeaseLost>;
};

/** The cron timer slice of `ExecutionRepo`. */
export type CronRepoMethods = {
  /** The writes of one pass over a `cron` row, fenced on `fence`. */
  readonly fencedCron: (fence: CronFence) => CronPassWrites;
};

/** Builds the writes of one pass over a `cron` row, fenced on `fence`. */
function makeCronPassWrites(
  database: Database["Service"],
  fence: CronFence
): CronPassWrites {
  const thisTimer = eq(workflowExecutionSchedule.id, fence.scheduleId);
  return {
    ...makePassWrites(database, fence),

    fireCronTimer: (input) =>
      writeFencedSerializable(
        database,
        fence,
        async (tx): Promise<CronFire> => {
          const verdict = cronFireVerdict(
            await timerWorkflow(tx, fence.workflowId),
            input
          );
          if (verdict !== "fire") {
            if (verdict.kind === "dropped") {
              await tx.delete(workflowExecutionSchedule).where(thisTimer);
            }
            return verdict;
          }

          const start = await admitWithConcurrency(tx, {
            ...input.start,
            execution: {
              ...input.start.execution,
              scheduled: { slot: input.slot, schedule: input.schedule },
            },
            now: input.now,
          });
          if (start.status === "refused") {
            await recordAuditEventWrite({
              workflowId: fence.workflowId,
              eventType: "run_refused",
              message: input.refusedEntry.message,
              metadata: {
                ...input.refusedEntry.metadata,
                inFlightExecutionIds: start.inFlightExecutionIds,
              },
            })(tx);
          }
          await tx
            .update(workflowExecutionSchedule)
            .set({
              ...RELEASED_LEASE,
              wakeAt: input.nextWakeAt,
              lastError: null,
            })
            .where(thisTimer);
          return { kind: "fired", start };
        },
        "update"
      ),

    skipCronSlot: (input) =>
      writeFenced(
        database,
        fence,
        async (tx): Promise<CronSkip> => {
          if (input.expected !== undefined) {
            const verdict = cronPublicationVerdict(
              await timerWorkflow(tx, fence.workflowId),
              input.expected
            );
            if (verdict !== "current") {
              if (verdict.kind === "dropped") {
                await tx.delete(workflowExecutionSchedule).where(thisTimer);
              }
              return verdict;
            }
          }
          await recordAuditEventWrite({
            workflowId: fence.workflowId,
            eventType: "run_refused",
            message: input.refusedEntry.message,
            metadata: input.refusedEntry.metadata,
          })(tx);
          await tx
            .update(workflowExecutionSchedule)
            .set({
              ...RELEASED_LEASE,
              wakeAt: input.nextWakeAt,
              lastError: input.error,
            })
            .where(thisTimer);
          return { kind: "skipped" };
        },
        "update"
      ),
  };
}

export function makeCronMethods(
  database: Database["Service"]
): CronRepoMethods {
  return {
    fencedCron: (fence) => makeCronPassWrites(database, fence),
  };
}
