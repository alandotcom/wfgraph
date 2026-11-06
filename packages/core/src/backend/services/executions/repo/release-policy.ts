/**
 * The database executor's scheduling decisions, made once for both backends:
 * which rows a claim leases, how many failures a step or a run may have, what
 * a claim counts when it sweeps an expired lease, which parks it times out,
 * what a release writes back, which runs a producer's wake re-queues, which
 * parks an Event, a re-park or a terminal write may take, which wake the
 * winner of an Exit claim gives the run's other parks, and what each producer
 * answers. A decision a statement makes is a Drizzle `sql` builder over the
 * columns each backend passes in. Each backend runs the statements inside its
 * own transaction, holding the schedule row first.
 */

import { countBy, sortBy } from "es-toolkit/array";
import { Effect } from "effect";
import { type Column, type SQL, sql } from "drizzle-orm";
import type {
  ExecutionScheduleKind,
  ParkWake,
} from "@wfgraph/shared/lifecycle/execution-schedule";
import type { JsonValue } from "@wfgraph/shared/types/json";
import type { WaitArrival } from "@wfgraph/shared/lifecycle/wait-signal";
import type {
  CanceledOutletClaim,
  ClaimedSchedule,
  CountedStepFailure,
  ExecutionSchedule,
  ExecutionTerminationState,
  ParkResolution,
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

/**
 * An instant as a backend binds it against one of its time columns: a `Date`
 * on PostgreSQL, epoch milliseconds on SQLite. Each builder binds it through
 * the column it is compared with, so the column's own encoding applies.
 */
export type BoundInstant = Date | number;

function instantOf(column: Column, now: BoundInstant): SQL {
  return sql`${sql.param(now, column)}`;
}

/**
 * The kinds of schedule row the claim leases, one per pass body. A `delivery`
 * row is left alone until a body runs it.
 */
const CLAIMED_SCHEDULE_KINDS = [
  "run",
] as const satisfies readonly ExecutionScheduleKind[];

function sqlLiterals(values: readonly string[]): SQL {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

/** The schedule row columns the claim and the producers' re-queue read. */
type ScheduleColumns = {
  kind: Column;
  state: Column;
  wakeAt: Column;
  leaseExpiresAt: Column;
};

/**
 * Whether a lease expired by `now`: the row is `leased` and its lease ends at
 * or before `now`, so the worker that held it stopped renewing it.
 */
function expiredLease(
  columns: Pick<ScheduleColumns, "state" | "leaseExpiresAt">,
  now: BoundInstant
): SQL {
  return sql`(${columns.state} = 'leased' and ${columns.leaseExpiresAt} <= ${instantOf(columns.leaseExpiresAt, now)})`;
}

/**
 * Whether the claim leases this row at `now`: its kind has a pass body, and it
 * is `queued` or `waiting` with `wake_at` at or before `now`, or its lease
 * expired (`expiredLease`).
 */
export function dueSchedule(columns: ScheduleColumns, now: BoundInstant): SQL {
  return sql`(${columns.kind} in (${sqlLiterals(CLAIMED_SCHEDULE_KINDS)}) and ((${columns.state} in ('queued', 'waiting') and ${columns.wakeAt} <= ${instantOf(columns.wakeAt, now)}) or ${expiredLease(columns, now)}))`;
}

/**
 * Whether a producer's wake re-queues this row at `now`: it is `waiting`, or
 * `queued` and not due until after `now`, so a run in a retry backoff is woken
 * at once. A `leased` row is left for its release, which reads the wakes, and
 * a row already due is left as it is.
 */
export function requeuedByWake(
  columns: Pick<ScheduleColumns, "state" | "wakeAt">,
  now: BoundInstant
): SQL {
  return sql`(${columns.state} = 'waiting' or (${columns.state} = 'queued' and ${columns.wakeAt} > ${instantOf(columns.wakeAt, now)}))`;
}

/** The `wake_at` a re-queued row takes: `now`, or its own when that is earlier. */
export function requeuedWakeAt(
  columns: Pick<ScheduleColumns, "wakeAt">,
  now: BoundInstant
): SQL {
  return sql`case when ${columns.wakeAt} > ${instantOf(columns.wakeAt, now)} then ${instantOf(columns.wakeAt, now)} else ${columns.wakeAt} end`;
}

/** The wait row columns the park decisions read. */
type ParkColumns = {
  status: Column;
  waitUntil: Column;
  wake: Column;
};

/** The kind of the wake a wait row holds, read from its JSON in either backend. */
function wakeKind(columns: Pick<ParkColumns, "wake">): SQL {
  return sql`(${columns.wake} ->> 'kind')`;
}

/** Whether a park's deadline passed by `now` while it was still `waiting`. */
export function overduePark(
  columns: Pick<ParkColumns, "status" | "waitUntil">,
  now: BoundInstant
): SQL {
  return sql`(${columns.status} = 'waiting' and ${columns.waitUntil} <= ${instantOf(columns.waitUntil, now)})`;
}

/** Whether a park is open as `OPEN_PARK_STATUSES` describes, which a terminal write cancels. */
export function openPark(columns: Pick<ParkColumns, "status">): SQL {
  return sql`${columns.status} in (${sqlLiterals(OPEN_PARK_STATUSES)})`;
}

/**
 * Whether an Event or a manual resume may claim this park: one still
 * `waiting`, or one whose pending wake is a Migration's `migrate` wake. An
 * Event that arrives while that wake is pending replaces it, and the next pass
 * reads the Event and resumes the Wait under the version the run was moved
 * to. Any other wake has already won the park.
 */
export function claimablePark(
  columns: Pick<ParkColumns, "status" | "wake">
): SQL {
  return sql`(${columns.status} = 'waiting' or (${columns.status} = 'resuming' and ${wakeKind(columns)} = 'migrate'))`;
}

/**
 * Whether this delivery's own claim already resolved the park: `resuming` with
 * the `resume` wake the claim wrote, naming `deliveryId`. A delivery that
 * crashed after its claim committed finds its park in this state.
 */
export function claimedByDelivery(
  columns: Pick<ParkColumns, "status" | "wake">,
  deliveryId: string
): SQL {
  return sql`(${columns.status} = 'resuming' and ${wakeKind(columns)} = 'resume' and (${columns.wake} ->> 'deliveryId') = ${deliveryId})`;
}

/**
 * Whether a re-park may write over this park: one still `waiting`, or one the
 * executor resolved with a wake the re-park supersedes. A `migrate` wake is
 * the instruction to prepare again, and a `timeout` wake read under a version
 * the run has since left is discarded the same way. Any other wake is an Event
 * or a claim the Wait still has to act on.
 */
export function reparkablePark(
  columns: Pick<ParkColumns, "status" | "wake">
): SQL {
  return sql`(${columns.status} = 'waiting' or (${columns.status} = 'resuming' and ${wakeKind(columns)} in ('migrate', 'timeout')))`;
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
    case "interrupted":
      return {
        state: "queued",
        wakeAt: now,
        attempt: input.attempt,
        lastError: null,
      };
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

/** What `wakePark` answers, from whether it set the wake and the rows it made due. */
export function parkResolution(produced: {
  result: boolean;
  due: readonly unknown[];
}): ParkResolution {
  return { resolved: produced.result, requeued: produced.due.length > 0 };
}

/**
 * Whether a run's open parks are exactly the Waits a Migration classified, each
 * still `waiting` under the resume token it was classified with. A wake, a
 * re-park or a newly parked branch changes the set, which refuses the repin.
 */
export function matchesClassification(
  parked: readonly { id: string; resumeToken: string | null; status: string }[],
  classified: readonly { id: string; resumeToken: string | null }[]
): boolean {
  const expected = new Map(
    classified.map((wait) => [wait.id, wait.resumeToken])
  );
  return (
    expected.size === classified.length &&
    parked.length === expected.size &&
    parked.every(
      (wait) =>
        wait.status === "waiting" &&
        expected.has(wait.id) &&
        expected.get(wait.id) === wait.resumeToken
    )
  );
}

/** The wake an Event or a manual resume writes onto the park it claimed. */
export function resumeWakeOf(arrival: WaitArrival): ParkWake {
  return {
    kind: "resume",
    eventName: arrival.eventName,
    payload: arrival.payload,
    deliveryId: arrival.deliveryId ?? null,
  };
}

/**
 * The arrival a `resume` wake carries, or null for any other wake. The wake
 * column is the one record of a resume, so this is how a timeout learns that a
 * resume won the park first.
 */
export function arrivalOfWake(wake: ParkWake | null): WaitArrival | null {
  if (wake?.kind !== "resume") return null;
  return {
    eventName: wake.eventName,
    payload: wake.payload,
    deliveryId: wake.deliveryId ?? undefined,
  };
}

/** A schedule row a producer made due, with the run it schedules. */
export type DueSchedule = { scheduleId: string; executionId: string | null };

/**
 * What `requestCancelForEntity` answers, from the runs its claim flagged, the
 * run of each park its `cancel` wake resolved, and the rows it made due.
 */
export function canceledOutletClaims(produced: {
  result: { flagged: readonly string[]; resolved: readonly string[] };
  due: readonly DueSchedule[];
}): CanceledOutletClaim[] {
  const parksByRun = countBy(produced.result.resolved, (id) => id);
  const due = new Set(produced.due.map((row) => row.executionId));
  return produced.result.flagged.map((executionId) => ({
    executionId,
    resolvedParks: parksByRun[executionId] ?? 0,
    requeued: due.has(executionId),
  }));
}

/**
 * A row the claim just leased, as its pass sees it. The claim wrote the token
 * and the lease expiry and leases only the kinds `CLAIMED_SCHEDULE_KINDS`
 * names, and a `run` row always names its Execution, so a row missing any of
 * them is a defect.
 */
function claimedSchedule(
  row: ExecutionSchedule
): Effect.Effect<ClaimedSchedule> {
  const { ownerToken, leaseExpiresAt, executionId } = row;
  if (
    row.kind === "run" &&
    ownerToken !== null &&
    leaseExpiresAt !== null &&
    executionId !== null
  ) {
    return Effect.succeed({
      kind: row.kind,
      scheduleId: row.id,
      executionId,
      ownerToken,
      attempt: row.attempt,
      leaseExpiresAt,
    });
  }
  return Effect.die(
    new Error(
      `The claimed schedule row ${row.id} carries no lease, or runs nothing a pass runs`
    )
  );
}

/** The rows a claim leased, oldest `wake_at` first, as their passes see them. */
export function claimedSchedules(
  rows: readonly ExecutionSchedule[]
): Effect.Effect<ClaimedSchedule[]> {
  return Effect.forEach(
    sortBy(rows, [(row) => row.wakeAt.getTime(), (row) => row.id]),
    claimedSchedule
  );
}

/** A memo row's columns, as both backends read them back. */
export type StepMemoColumns = {
  status: string;
  failures: number;
  value: JsonValue | null;
  error: string | null;
};

/** A memo row's columns as a `StepMemo`. The table's checks keep them consistent. */
export function stepMemoOf(row: StepMemoColumns): StepMemo {
  const { status, failures, error } = row;
  if (status === "succeeded") {
    return { status, failures, value: row.value ?? null };
  }
  if ((status === "failing" || status === "failed") && error !== null) {
    return { status, failures, error };
  }
  throw new Error(`A step memo row holds the invalid status ${status}`);
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
