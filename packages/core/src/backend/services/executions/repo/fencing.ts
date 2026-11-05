/**
 * What both backends share about the database executor's writes: the refusal a
 * fenced write answers, the run-log row id that makes a re-run log open
 * idempotent, and the decision a release makes.
 *
 * Each backend takes its own locks; nothing here touches a database.
 */

import { createHash } from "node:crypto";
import { Conflict } from "#src/backend/lib/effect/failures";
import type {
  PassOutcome,
  ReleasedSchedule,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo/contracts";

/**
 * The refusal a fenced write answers when the Execution's schedule row no
 * longer names the pass: its lease expired and another claim took the run, a
 * policy cancel or a terminal write deleted the row, or the row was released.
 */
export function ownershipLost(): Conflict {
  return new Conflict({
    error: "The pass no longer holds this run's lease",
  });
}

function sha256(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

/**
 * The id of a node's run-log row.
 *
 * A node opens its row at most once per Execution, in one durable step whose id
 * is built from the node id (`node:<id>:log-open`, or `wait-start-log-<id>` for
 * a Wait), so the Execution and the node name the step that opens the row. A
 * re-run of that step therefore inserts the same id, and the insert's conflict
 * leaves the first row in place.
 */
export function nodeLogId(executionId: string, nodeId: string): string {
  return `log_${sha256([executionId, nodeId])}`;
}

/**
 * The wake time a release writes for a run whose open parks carry no deadline.
 * Only a producer's wake re-queues such a run, so it sorts after every real
 * deadline.
 */
export const UNDATED_PARK_WAKE_AT = new Date("9999-12-31T00:00:00.000Z");

/** One of the run's wait rows as a release reads it. */
export type ReleasePark = {
  status: WorkflowWaitState["status"];
  waitUntil: Date | null;
  /** Whether a producer or a claim has written a wake onto the row. */
  woken: boolean;
};

/**
 * The schedule row a release writes, decided from the pass's outcome and the
 * run's wait rows as they stand once the schedule row is locked.
 *
 * A row `resuming` with a wake holds a wake no pass has consumed, because the
 * pass that consumes one settles the row out of `resuming`.
 */
export function decideRelease(input: {
  outcome: PassOutcome;
  attempt: number;
  now: Date;
  parks: readonly ReleasePark[];
}): ReleasedSchedule & { lastError: string | null } {
  const { outcome, attempt, now } = input;
  if (outcome.kind === "retry") {
    return {
      state: "queued",
      wakeAt: new Date(now.getTime() + outcome.backoffMs),
      attempt: attempt + 1,
      lastError: outcome.error,
    };
  }
  if (outcome.kind === "retries_spent") {
    return { state: "queued", wakeAt: now, attempt: 0, lastError: null };
  }
  if (outcome.kind === "fence_refused") {
    return { state: "queued", wakeAt: now, attempt, lastError: null };
  }

  const unconsumedWake = input.parks.some(
    (park) => park.status === "resuming" && park.woken
  );
  const open = input.parks.filter((park) => park.status === "waiting");
  // A pass that ended parked with nothing left waiting has nothing to sleep on,
  // so the run goes back to the queue rather than to sleep for good.
  if (unconsumedWake || open.length === 0) {
    return { state: "queued", wakeAt: now, attempt, lastError: null };
  }
  const deadlines = open.flatMap((park) =>
    park.waitUntil === null ? [] : [park.waitUntil.getTime()]
  );
  return {
    state: "waiting",
    wakeAt:
      deadlines.length === 0
        ? UNDATED_PARK_WAKE_AT
        : new Date(Math.min(...deadlines)),
    attempt,
    lastError: null,
  };
}
