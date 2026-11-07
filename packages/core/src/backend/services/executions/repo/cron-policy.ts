/**
 * The decisions behind a cron schedule's timer row, made once for both
 * backends: which timers Publish keeps, deletes and writes, when a new timer
 * and a fired timer next wake, which slot a fire runs, and whether a fire may
 * commit against the workflow as its transaction reads it.
 */

import { differenceWith, partition } from "es-toolkit/array";
import {
  type CronSchedule,
  latestSlotAtOrBefore,
  nextFireAfter,
  sameSchedule,
} from "@wfgraph/shared/lifecycle/cron-schedule";
import type {
  SerializedWorkflowGraph,
  WorkflowMode,
} from "@wfgraph/shared/graph/types";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { graphCronSchedules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type {
  CronPublication,
  CronRefusal,
  FireCronTimerInput,
} from "#src/backend/services/executions/repo/contracts";
import { UNDATED_PARK_WAKE_AT } from "#src/backend/services/executions/repo/release-policy";

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
 * schedule's identity, so an edit is a removal and an addition. `keepIds`
 * names the rows that stay.
 */
export function cronTimerChanges(input: {
  rows: readonly CronTimerRow[];
  schedules: readonly CronSchedule[];
}): { keepIds: string[]; deleteIds: string[]; insert: CronSchedule[] } {
  const [kept, removed] = partition(input.rows, (row) =>
    input.schedules.some((schedule) => sameSchedule(row, schedule))
  );
  return {
    keepIds: kept.map((row) => row.id),
    deleteIds: removed.map((row) => row.id),
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

/** The workflow row as a fire or a skip reads it. */
export type CronFireWorkflow = {
  isPaused: boolean;
  publishedVersionId: string | null;
  mode: WorkflowMode;
};

/**
 * Whether a fire or a skip may write its slot, from the workflow row its
 * transaction read and the publication its preflight checked. Pause deletes
 * a paused workflow's timers, and the fence refuses a pass whose row it
 * deleted, so `dropped` answers a row that should not exist.
 */
export function cronPublicationVerdict(
  workflow: CronFireWorkflow,
  expected: CronPublication
): "current" | CronRefusal {
  if (workflow.isPaused) {
    return { kind: "dropped", reason: "workflow_paused" };
  }
  if (workflow.publishedVersionId === null) {
    return { kind: "dropped", reason: "not_published" };
  }
  if (
    workflow.publishedVersionId !== expected.versionId ||
    workflow.mode !== expected.mode
  ) {
    return { kind: "stale" };
  }
  return "current";
}

/**
 * Whether a fire may open its run: `cronPublicationVerdict`, and then whether
 * the version it checked still declares the schedule. Publish deletes the
 * timer of a schedule it removes, so that `dropped` also answers a row that
 * should not exist.
 */
export function cronFireVerdict(
  workflow: CronFireWorkflow,
  input: Pick<FireCronTimerInput, "schedule" | "expected">
): "fire" | CronRefusal {
  const publication = cronPublicationVerdict(workflow, input.expected);
  if (publication !== "current") return publication;
  if (
    !input.expected.schedules.some((schedule) =>
      sameSchedule(schedule, input.schedule)
    )
  ) {
    return { kind: "dropped", reason: "schedule_unpublished" };
  }
  return "fire";
}
