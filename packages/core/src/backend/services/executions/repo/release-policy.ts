/**
 * The database executor's scheduling decisions, made once for both backends:
 * how many failures a step or a run may have, what a claim counts when it
 * sweeps an expired lease, what a release writes back, which wake the winner
 * of an Exit claim gives the run's other parks, and what a terminal write
 * closes. Each backend runs the statements these decisions call for inside its
 * own transaction, holding the schedule row first.
 */

import { type Column, type SQL, sql } from "drizzle-orm";
import type { ParkWake } from "@wfgraph/shared/lifecycle/execution-schedule";
import type {
  CountedStepFailure,
  ExecutionTerminationState,
  PassOutcome,
  ReleasedSchedule,
  StepMemo,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo/contracts";

/**
 * How many retries a failing step gets before it fails its node. The fifth
 * failure of one step makes its memo row `failed`. The run's own failure count
 * is held to the same limit.
 */
export const STEP_RETRY_LIMIT = 4;

/** The wait before a retry after `failures` failures: one second, doubling, at most a minute. */
export function retryBackoffMs(failures: number): number {
  return Math.min(1_000 * 2 ** failures, 60_000);
}

/** The error a claim records on a step whose pass stopped renewing its lease. */
export const LEASE_EXPIRED_ERROR =
  "The worker running this step stopped renewing its lease";

/** The wake a claim writes onto a park whose deadline passed. */
export const TIMEOUT_WAKE: ParkWake = { kind: "timeout" };

/**
 * The wake time a release writes for a run whose open parks carry no deadline.
 * Only a producer's wake re-queues such a run, so it sorts after every real
 * deadline.
 */
export const UNDATED_PARK_WAKE_AT = new Date("9999-12-31T00:00:00.000Z");

/**
 * The wait row statuses a run's terminal write cancels: every park still
 * waiting, and every park holding a wake no pass consumed. A terminal write
 * also deletes the run's schedule row, which deletes its step memo with it.
 * The log rows stay.
 */
export const OPEN_PARK_STATUSES = [
  "waiting",
  "resuming",
] as const satisfies readonly WorkflowWaitState["status"][];

/**
 * The memo row a step's failure leaves, given the row before it: one more
 * failure, and `failed` once the count passes `STEP_RETRY_LIMIT`. A row that
 * already succeeded or already failed is left alone, which answers null.
 */
export function countStepFailure(
  previous: StepMemo | undefined,
  error: string
): CountedStepFailure | null {
  if (previous !== undefined && previous.status !== "failing") return null;
  const failures = (previous?.failures ?? 0) + 1;
  return {
    status: failures > STEP_RETRY_LIMIT ? "failed" : "failing",
    failures,
    error,
  };
}

/** Whether the run's own failure count has passed the limit, which ends the run failed. */
export function runRetriesSpent(attempt: number): boolean {
  return attempt > STEP_RETRY_LIMIT;
}

/** The schedule row columns the claim's counting rule reads. */
type ClaimColumns = {
  state: Column;
  attempt: Column;
  runningStepId: Column;
};

/**
 * The claim's counting rule, as the value it writes to `attempt`: a row whose
 * lease expired while no step was recorded as running counts one failure
 * against the run. A row queued by a wake or by a release spends nothing, and
 * a lease that expired under a recorded step counts against that step instead
 * (`sweptStepFailures`).
 */
export function claimAttempt(columns: ClaimColumns): SQL {
  return sql`case when ${columns.state} = 'leased' and ${columns.runningStepId} is null then ${columns.attempt} + 1 else ${columns.attempt} end`;
}

/** A due row as the claim reads it before leasing it. */
export type DueRow = {
  id: string;
  state: string;
  runningStepId: string | null;
};

/**
 * The steps whose expired leases a claim counts a failure against: each
 * claimed row that was still `leased` with a step recorded as running.
 */
export function sweptStepFailures(
  rows: readonly DueRow[]
): { scheduleId: string; stepId: string }[] {
  return rows.flatMap((row) =>
    row.state === "leased" && row.runningStepId !== null
      ? [{ scheduleId: row.id, stepId: row.runningStepId }]
      : []
  );
}

/** One of the run's wait rows as a release reads it. */
export type ReleasePark = {
  status: WorkflowWaitState["status"];
  waitUntil: Date | null;
  /** Whether a producer or a claim has written a wake onto the row. */
  woken: boolean;
};

/** The schedule row a release writes. */
export type ReleaseDecision = ReleasedSchedule & { lastError: string | null };

/**
 * The schedule row a release writes, decided from the pass's outcome, the
 * run's own failure count, the run's wait rows as they stand once the schedule
 * row is locked, and, for a `step_failed` outcome, the memo row the release
 * counted that failure on.
 *
 * A row `resuming` with a wake holds a wake no pass has consumed, because the
 * pass that consumes one settles the row out of `resuming`.
 */
export function decideRelease(input: {
  outcome: PassOutcome;
  attempt: number;
  now: Date;
  parks: readonly ReleasePark[];
  countedStep: CountedStepFailure | null;
}): ReleaseDecision {
  const { outcome, now } = input;
  const at = (delayMs: number) => new Date(now.getTime() + delayMs);
  switch (outcome.kind) {
    case "step_failed":
      // A step whose retries are spent fails its node on the next pass, which
      // has nothing to wait for.
      return {
        state: "queued",
        wakeAt:
          input.countedStep?.status === "failing" ? at(outcome.backoffMs) : now,
        attempt: 0,
        lastError: outcome.error,
      };
    case "run_failed":
      return {
        state: "queued",
        wakeAt: at(outcome.backoffMs),
        attempt: input.attempt + 1,
        lastError: outcome.error,
      };
    case "fence_refused":
      return { state: "queued", wakeAt: now, attempt: 0, lastError: null };
    default:
      return decideParkedRelease(input.parks, now);
  }
}

function decideParkedRelease(
  parks: readonly ReleasePark[],
  now: Date
): ReleaseDecision {
  const unconsumedWake = parks.some(
    (park) => park.status === "resuming" && park.woken
  );
  const open = parks.filter((park) => park.status === "waiting");
  // A pass that ended parked with nothing left waiting has nothing to sleep on,
  // so the run goes back to the queue rather than to sleep for good.
  if (unconsumedWake || open.length === 0) {
    return { state: "queued", wakeAt: now, attempt: 0, lastError: null };
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
    attempt: 0,
    lastError: null,
  };
}

/**
 * The wake the pass that wrote an Exit claim gives the run's other open parks,
 * in the same transaction, so a parked sibling halts on the next pass rather
 * than holding the run until its own deadline. A pass whose claim lost to an
 * earlier one resolves nothing, which answers null.
 */
export function exitWakeForClaim(
  state: ExecutionTerminationState | null
): ParkWake | null {
  return state?.didWrite === true ? { kind: "exit" } : null;
}
