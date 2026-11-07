/**
 * The pass body of a `cron` schedule row: fire the timer with `fireSchedule`
 * and write the fire's one record. The fire's own transaction releases the
 * lease, so a body that fired ends its pass with no release to write. A body
 * whose retries are spent skips the slot it was firing, with a Refused Start.
 */

import { Effect } from "effect";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  cronLogSubject,
  type CronPass,
  type OpenedBody,
  type PassBody,
  passAnnotations,
} from "#src/backend/executor/pass";
import {
  fireSchedule,
  type ScheduleFireOutcome,
  skipSpentSchedule,
} from "#src/backend/services/workflows/lifecycle/scheduled-start";

/** Every service a cron row's pass reads. */
export type CronServices = Effect.Services<ReturnType<typeof fireSchedule>>;

/** The record's message and level for each way a fire ends. */
const RECORDS = {
  started: { message: "Fired a cron schedule", level: "Info" },
  refused: { message: "Fired a cron schedule", level: "Info" },
  skipped: { message: "Skipped a cron slot", level: "Warn" },
  dropped: { message: "Dropped a cron timer", level: "Warn" },
} as const satisfies Record<
  ScheduleFireOutcome["kind"],
  { message: string; level: "Info" | "Warn" }
>;

/** The `run` group of a fire's record, for a fire that read a version. */
function runFields(outcome: ScheduleFireOutcome) {
  switch (outcome.kind) {
    case "started":
      return {
        run: { execution: outcome.executionId, version: outcome.versionId },
      };
    case "refused":
      return { run: { version: outcome.versionId } };
    default:
      return {};
  }
}

/** The `outcome` group of a fire's record. */
function outcomeFields(outcome: ScheduleFireOutcome) {
  switch (outcome.kind) {
    case "started":
      return omitUndefined({
        kind: outcome.kind,
        nextWakeAt: outcome.nextWakeAt,
        superseded: outcome.superseded > 0 ? outcome.superseded : undefined,
        failedToSupersede:
          outcome.failedToSupersede.length > 0
            ? outcome.failedToSupersede.length
            : undefined,
      });
    case "refused":
      return {
        kind: outcome.kind,
        nextWakeAt: outcome.nextWakeAt,
        inFlight: outcome.inFlightExecutionIds.length,
      };
    case "skipped":
      return { kind: outcome.kind, nextWakeAt: outcome.nextWakeAt };
    default:
      return { kind: outcome.kind, reason: outcome.reason };
  }
}

/**
 * The fire's one record, grouped by its timer, which carries the slot the
 * fire was for, its run and its outcome. A skip after spent retries writes it
 * too, so the pass writes no record of its own for that.
 */
function logFire(pass: CronPass, outcome: ScheduleFireOutcome) {
  const { message, level } = RECORDS[outcome.kind];
  return Effect.logWithLevel(level)(message).pipe(
    Effect.annotateLogs(
      omitUndefined({
        ...passAnnotations(pass.claimed, pass.workerId),
        cron: omitUndefined({
          ...cronLogSubject(pass.claimed),
          slot: outcome.kind === "dropped" ? undefined : outcome.slot,
        }),
        ...runFields(outcome),
        outcome: outcomeFields(outcome),
        error: outcome.kind === "skipped" ? outcome.error : undefined,
      })
    )
  );
}

export function cronBody(): PassBody<CronPass, CronServices> {
  return {
    open: (pass) =>
      Effect.succeed({
        kind: "ready",
        run: () =>
          fireSchedule({
            writes: pass.writes,
            workflowId: pass.claimed.workflowId,
            schedule: pass.claimed.schedule,
            now: pass.now,
          }).pipe(
            Effect.tap((outcome) => logFire(pass, outcome)),
            Effect.as({ kind: "ended" as const })
          ),
      } satisfies OpenedBody<null, CronServices>),
    fail: (pass, error) =>
      skipSpentSchedule({
        writes: pass.writes,
        workflowId: pass.claimed.workflowId,
        schedule: pass.claimed.schedule,
        error,
        now: pass.now(),
      }).pipe(
        Effect.tap((outcome) => logFire(pass, outcome)),
        Effect.asVoid
      ),
  };
}
