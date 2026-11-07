/**
 * The decisions behind a cron schedule's timer row, made once for both
 * backends: which timers Publish keeps, deletes and writes, when a new timer
 * and a fired timer next wake, which slot a fire runs, and whether a fire may
 * commit against the workflow as its transaction reads it.
 */

import { differenceWith } from "es-toolkit/array";
import {
  type CronSchedule,
  latestSlotAtOrBefore,
  nextFireAfter,
} from "@wfgraph/shared/lifecycle/cron-schedule";
import type {
  SerializedWorkflowGraph,
  WorkflowMode,
} from "@wfgraph/shared/graph/types";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { graphCronSchedules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type {
  CronFire,
  FireCronTimerInput,
} from "#src/backend/services/executions/repo/contracts";
import { UNDATED_PARK_WAKE_AT } from "#src/backend/services/executions/repo/release-policy";

/** Whether two schedules are the same schedule: the same expression in the same zone. */
export function sameSchedule(left: CronSchedule, right: CronSchedule): boolean {
  return left.cron === right.cron && left.timeZone === right.timeZone;
}

/**
 * The schedules a version declares, read from its graph's entry node. Publish
 * writes a version's timers from them, and so does a resume of the version a
 * workflow publishes.
 */
export function versionCronSchedules(
  graph: SerializedWorkflowGraph
): readonly CronSchedule[] {
  return graphCronSchedules(toWorkflowGraphData(graph).nodes);
}

/** A timer row as the timer writes read it: its id and the schedule it times. */
export type CronTimerRow = { id: string } & CronSchedule;

/**
 * What Publish does to a workflow's timer rows, given the rows it has and the
 * schedules the version it activates declares. The row of a schedule the
 * version keeps unchanged stays, lease and all. The row of a schedule the
 * version edits or removes is deleted, and a schedule it edits or adds gets a
 * new row. An edit changes the expression or the zone, which is the
 * schedule's identity, so an edit is a removal and an addition.
 */
export function cronTimerChanges(input: {
  rows: readonly CronTimerRow[];
  schedules: readonly CronSchedule[];
}): { deleteIds: string[]; insert: CronSchedule[] } {
  return {
    deleteIds: differenceWith(input.rows, input.schedules, sameSchedule).map(
      (row) => row.id
    ),
    insert: differenceWith(input.schedules, input.rows, sameSchedule),
  };
}

/**
 * When a timer next wakes after `now`: the schedule's first slot strictly
 * after it. A timer written by Publish or by a resume, and a timer a fire
 * advances, all wake here, so no timer fires a slot at or before the write
 * that set it. An expression with no later slot sleeps past every real one.
 */
export function cronWakeAfter(schedule: CronSchedule, now: Date): Date {
  return nextFireAfter(schedule, now) ?? UNDATED_PARK_WAKE_AT;
}

/**
 * The slot a fire at `now` runs: the latest one at or before `now`. A timer
 * claimed late fires once, for the slot it missed last. The claim found the
 * row due, so `wakeAt`, itself a slot, is at or before `now` and answers for
 * an expression croner finds no earlier slot of.
 */
export function cronSlotAt(
  schedule: CronSchedule,
  now: Date,
  wakeAt: Date
): Date {
  return latestSlotAtOrBefore(schedule, now) ?? wakeAt;
}

/** The workflow row as a fire reads it, or null when the workflow is gone. */
export type CronFireWorkflow = {
  isPaused: boolean;
  publishedVersionId: string | null;
  mode: WorkflowMode;
};

/**
 * Whether a fire may commit, from the workflow row its transaction read.
 * Pause and Publish delete the timer of a schedule that can no longer fire,
 * and the fence refuses a pass whose row they deleted, so `dropped` answers a
 * row that should not exist.
 */
export function cronFireVerdict(
  workflow: CronFireWorkflow,
  input: Pick<FireCronTimerInput, "schedule" | "expected">
): "fire" | Exclude<CronFire, { kind: "fired" }> {
  if (workflow.isPaused) {
    return { kind: "dropped", reason: "workflow_paused" };
  }
  if (workflow.publishedVersionId === null) {
    return { kind: "dropped", reason: "not_published" };
  }
  if (
    workflow.publishedVersionId !== input.expected.versionId ||
    workflow.mode !== input.expected.mode
  ) {
    return { kind: "stale" };
  }
  if (
    !input.expected.schedules.some((schedule) =>
      sameSchedule(schedule, input.schedule)
    )
  ) {
    return { kind: "dropped", reason: "schedule_unpublished" };
  }
  return "fire";
}
