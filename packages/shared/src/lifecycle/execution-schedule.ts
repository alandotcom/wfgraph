/**
 * The database executor's vocabulary: what a schedule row runs, where it
 * stands, what a step's memo row records, and how a park ended.
 *
 * The rows are written and read through `ExecutionRepo`. This module lives in
 * shared so the Drizzle schema can type its columns and build its check
 * constraints without importing through `#src/` (drizzle-kit's schema loader
 * cannot resolve that subpath).
 */

import type { JsonObject } from "#src/types/json";

/** The kinds of `ParkWake` that carry nothing beside their kind. */
export const BARE_PARK_WAKE_KINDS = [
  "timeout",
  "migrate",
  "cancel",
  "exit",
] as const;

/** Every kind of `ParkWake`. */
export const PARK_WAKE_KINDS = [...BARE_PARK_WAKE_KINDS, "resume"] as const;

/**
 * How a park ended, as `workflow_wait_states.wake` stores it.
 *
 * `timeout` is the park's deadline passing. `resume` is an Event arrival or a
 * manual resume, carrying what arrived. `cancel` is a Cancel Event claiming the
 * run, `exit` is another branch of the run claiming an Entity Eligibility Exit,
 * and `migrate` is a Migration telling the Wait to prepare itself again against
 * the version the run now pins.
 */
export type ParkWake =
  | { kind: (typeof BARE_PARK_WAKE_KINDS)[number] }
  | {
      kind: "resume";
      /** The Event that arrived, and null for a resume that named none. */
      eventName: string | null;
      payload: JsonObject;
      /** The delivery that carried the Event, and null when none did. */
      deliveryId: string | null;
    };

/**
 * What a schedule row runs: a workflow run (`run`), which names its Execution,
 * an Event's delivery to the workflows subscribed to it (`delivery`), which
 * names its inbox row, or the timer of one cron schedule (`cron`), which names
 * its workflow and the schedule's expression and time zone.
 */
export const EXECUTION_SCHEDULE_KINDS = ["run", "delivery", "cron"] as const;
export type ExecutionScheduleKind = (typeof EXECUTION_SCHEDULE_KINDS)[number];

/**
 * Where a schedule row stands. `queued` is due at `wake_at`, `leased` is held by
 * one worker's pass until `lease_expires_at`, and `waiting` is a run with every
 * branch parked, due again at its earliest park deadline.
 */
export const EXECUTION_SCHEDULE_STATES = [
  "queued",
  "leased",
  "waiting",
] as const;
export type ExecutionScheduleState = (typeof EXECUTION_SCHEDULE_STATES)[number];

/**
 * Where one durable step's memo row stands.
 *
 * `succeeded` holds the value the step answered, which every later pass
 * returns without running the step. `failing` counts the retriable failures
 * the step has had so far, and the step runs again on the next pass. `failed`
 * is a step whose retries are spent: every later pass answers it by failing
 * with the row's error, which fails the step's node.
 */
export const STEP_MEMO_STATUSES = ["succeeded", "failing", "failed"] as const;
export type StepMemoStatus = (typeof STEP_MEMO_STATUSES)[number];
