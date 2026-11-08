/**
 * `fireSchedule` starts a scheduled run, a run of the published version that
 * names no Event, when a cron timer falls due. It runs a manual start's
 * preflight, then fires or skips the slot through the cron pass's own writes,
 * each one transaction fenced on the lease. A lost lease fails `LeaseLost`.
 */

import { Effect, Schema } from "effect";
import {
  type CronSchedule,
  latestSlotAtOrBefore,
} from "@wfgraph/shared/lifecycle/cron-schedule";
import {
  type WorkflowExecutionIgnoredReason,
  workflowEntityValue,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import { emptyLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { encodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";
import { annotateServiceSpan } from "#src/backend/lib/telemetry";
import { ExecutionDriver } from "#src/backend/services/executions/driver";
import { runWorkflowExecutionPreflight } from "#src/backend/services/executions/preflight";
import type {
  CronFire,
  CronPassWrites,
  CronPublication,
  CronRefusal,
  CronRefusedEntry,
} from "#src/backend/services/executions/repo";
import { cronWakeAfter } from "#src/backend/services/executions/repo/cron-policy";
import {
  buildIgnoredRunAuditMessage,
  toWorkflowRunTarget,
} from "#src/backend/services/executions/run-rows";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { startRequestFor } from "#src/backend/services/workflows/lifecycle/concurrency";

/**
 * How many times one fire checks the published version, when its fire or its
 * skip finds that a Publish or a mode change moved it since the preflight. A
 * fire that still finds it moved fails, and the pass retries it after a
 * backoff.
 */
const STALE_FIRE_ATTEMPTS = 3;

/**
 * A fire that found the published version or the Published mode moved on each
 * of its `STALE_FIRE_ATTEMPTS` checks. The pass counts it as a failure of the
 * body and fires again after a backoff.
 */
class PublicationKeptMoving extends Schema.TaggedError<
  PublicationKeptMoving,
  { readonly brand: unique symbol }
>()("PublicationKeptMoving", { message: Schema.String }) {}

/** The slot a fire runs, and the wake its timer moves to. */
type SlotTimes = { slot: Date; nextWakeAt: Date };

/**
 * The slot a fire at `now` runs, the schedule's latest at or before `now`, so
 * a timer claimed late fires once, for the slot it missed last, and the
 * timer's next wake, the schedule's first slot strictly after `now`. The claim
 * found the timer due at a slot at or before `now`, so an expression croner
 * finds no such slot for is a defect.
 */
function slotTimesAt(
  schedule: CronSchedule,
  now: Date
): Effect.Effect<SlotTimes> {
  const slot = latestSlotAtOrBefore(schedule, now);
  return slot === undefined
    ? Effect.die(
        new Error("A due cron timer's schedule has no slot at or before now")
      )
    : Effect.succeed({ slot, nextWakeAt: cronWakeAfter(schedule, now) });
}

/**
 * The Refused Start for `slot` of `schedule`, which does not run, for
 * `reason`, worded with the slot's time in the schedule's zone. `extra` is
 * what one reason knows and the others do not, such as the preflight's error,
 * and it stays on the row's metadata.
 */
export function scheduledRefusal(input: {
  schedule: CronSchedule;
  slot: Date;
  reason: WorkflowExecutionIgnoredReason;
  extra?: JsonObject | undefined;
}): CronRefusedEntry {
  const { schedule, slot, reason } = input;
  return {
    message: buildIgnoredRunAuditMessage({
      startSource: "schedule",
      reason,
      slot: { at: slot, timeZone: schedule.timeZone },
    }),
    metadata: {
      // The refusal's own keys are written last, so `extra` cannot rename the
      // row it is written on.
      ...input.extra,
      reason,
      startSource: "schedule",
      schedule: { cron: schedule.cron, timeZone: schedule.timeZone },
      scheduledFor: encodeIsoTimestamp(slot),
    },
  };
}

/**
 * What one fire did.
 *
 * - `started`: it opened a run for `slot`, superseding `superseded` runs under
 *   newest-wins.
 * - `refused`: first-wins deferred to the runs in flight, and the fire
 *   recorded a Refused Start for `slot`.
 * - `skipped`: the published graph cannot run, or the fire's retries are
 *   spent, so the fire recorded a Refused Start for `slot` and moved the
 *   timer on to `nextWakeAt`, recording `error`.
 * - `dropped`: the timer should not exist, and the fire deleted it.
 */
export type ScheduleFireOutcome =
  | {
      kind: "started";
      executionId: string;
      versionId: string;
      slot: Date;
      nextWakeAt: Date;
      superseded: number;
    }
  | {
      kind: "refused";
      versionId: string;
      slot: Date;
      nextWakeAt: Date;
      inFlightExecutionIds: string[];
    }
  | { kind: "skipped"; slot: Date; nextWakeAt: Date; error: string }
  | Extract<CronFire, { kind: "dropped" }>;

/** Puts how a fire ended on its span: the outcome's kind and its slot. */
function annotateFireOutcome(outcome: ScheduleFireOutcome) {
  return annotateServiceSpan({
    outcome: outcome.kind,
    scheduleSlot:
      outcome.kind === "dropped" ? undefined : encodeIsoTimestamp(outcome.slot),
  });
}

/**
 * Fires the timer of `schedule`, which a cron pass over `workflowId` holds
 * the lease on, through the pass's `writes`, at the pass's clock `now`.
 */
export const fireSchedule = Effect.fn("wfgraph.schedule.fire")(
  function* (input: {
    writes: CronPassWrites;
    workflowId: string;
    schedule: CronSchedule;
    now: () => Date;
  }) {
    yield* annotateServiceSpan({ workflowId: input.workflowId });
    const { writes, schedule } = input;
    const workflows = yield* WorkflowRepo;
    const driver = yield* ExecutionDriver;
    // The slot is not run: a Refused Start says so, and the timer moves on and
    // records why. The skip writes it only while the workflow still publishes
    // `expected`, so a Publish that repaired the graph since the preflight
    // gets its slot fired instead.
    const skip = (refusal: {
      times: SlotTimes;
      expected: CronPublication;
      error: string;
    }) => {
      const { times, expected, error } = refusal;
      return Effect.map(
        writes.skipCronSlot({
          expected,
          nextWakeAt: times.nextWakeAt,
          error,
          refusedEntry: scheduledRefusal({
            schedule,
            slot: times.slot,
            reason: "published_version_not_runnable",
            extra: {
              versionId: expected.versionId,
              runMode: expected.mode,
              error,
            },
          }),
        }),
        (skipped): ScheduleFireOutcome | CronRefusal =>
          skipped.kind === "skipped"
            ? { kind: "skipped", ...times, error }
            : skipped
      );
    };

    // One check of the published version, ending in one fire or one skip.
    // `stale` means the version or the mode moved since the preflight. The
    // clock is read once, before the transaction, and decides the slot.
    const attempt = Effect.gen(function* () {
      const loaded = yield* workflows.findByIdWithPublishedVersionForRun(
        input.workflowId
      );
      // A workflow deleted since the claim took its timer row with it by
      // cascade. Deleting the row through the pass's fence finds it gone,
      // which stops the pass as a lost lease, with no release written.
      if (loaded === null) {
        yield* writes.dropSchedule();
        return yield* Effect.die(
          new Error("A deleted workflow's cron timer outlived its cascade")
        );
      }
      // Publish writes a timer only for a published version, and no write
      // takes a workflow's publication away.
      if (loaded.publishedVersion === null) {
        return yield* Effect.die(
          new Error("A leased cron timer's workflow is unpublished")
        );
      }
      const { workflow, publishedVersion: version } = loaded;
      const expected: CronPublication = {
        versionId: version.id,
        mode: workflow.mode,
      };
      const now = input.now();
      const times = yield* slotTimesAt(schedule, now);

      const preflight = yield* runWorkflowExecutionPreflight({
        workflow: { graph: version.graph },
        workflowVersionId: version.id,
        catalogFingerprint: version.catalogFingerprint,
      }).pipe(
        Effect.map((checked) => ({ ok: true as const, checked })),
        Effect.catchTags({
          InvalidInput: (failure) =>
            Effect.succeed({ ok: false as const, error: failure.error }),
          IntegrationValidationFailed: (failure) =>
            Effect.succeed({ ok: false as const, error: failure.error }),
        })
      );
      if (!preflight.ok) {
        return yield* skip({ times, expected, error: preflight.error });
      }
      const rules = preflight.checked.lifecycleRules ?? emptyLifecycleRules;
      const entityValue = workflowEntityValue(workflow.id);
      const request = yield* startRequestFor({
        workflow: toWorkflowRunTarget({
          workflow,
          versionId: version.id,
          catalogFingerprint: version.catalogFingerprint,
          graph: preflight.checked.workflowGraph,
        }),
        concurrency: rules.concurrency,
        start: { source: "schedule", entityValue },
        runMode: workflow.mode,
        payload: {},
      });
      const fired = yield* driver.fireCronTimer({
        writes,
        schedule,
        expected: { ...expected, schedules: rules.schedules ?? [] },
        start: request,
        ...times,
        refusedEntry: scheduledRefusal({
          schedule,
          slot: times.slot,
          reason: "concurrency_first_wins",
          extra: { entityValue, runMode: workflow.mode },
        }),
        now,
      });

      if (fired.kind !== "fired") return fired;
      if (fired.start.status === "refused") {
        const refused: ScheduleFireOutcome = {
          kind: "refused",
          versionId: version.id,
          ...times,
          inFlightExecutionIds: fired.start.inFlightExecutionIds,
        };
        return refused;
      }

      const { execution, supersededExecutionIds } = fired.start;
      const started: ScheduleFireOutcome = {
        kind: "started",
        executionId: execution.id,
        versionId: version.id,
        ...times,
        superseded: supersededExecutionIds.length,
      };
      return started;
    });

    for (let tries = 0; tries < STALE_FIRE_ATTEMPTS; tries += 1) {
      const outcome = yield* attempt;
      if (outcome.kind !== "stale") {
        yield* annotateFireOutcome(outcome);
        return outcome;
      }
    }
    return yield* new PublicationKeptMoving({
      message:
        "The published version or the Published mode changed during every fire attempt",
    });
  }
);

/**
 * Skips the slot of `schedule`'s timer through the `writes` of a cron pass
 * over `workflowId`, at the pass's clock `now`, for a fire whose retries are
 * spent: a Refused Start says starting it failed on every retry, and the
 * timer moves on, recording `error`.
 */
export const skipSpentSchedule = Effect.fn("wfgraph.schedule.skip_spent")(
  function* (input: {
    writes: CronPassWrites;
    workflowId: string;
    schedule: CronSchedule;
    error: string;
    now: Date;
  }) {
    yield* annotateServiceSpan({ workflowId: input.workflowId });
    const { schedule, error } = input;
    const times = yield* slotTimesAt(schedule, input.now);
    yield* input.writes.skipCronSlot({
      nextWakeAt: times.nextWakeAt,
      error,
      refusedEntry: scheduledRefusal({
        schedule,
        slot: times.slot,
        reason: "scheduled_start_failed",
        extra: { error },
      }),
    });
    const skipped: ScheduleFireOutcome = { kind: "skipped", ...times, error };
    yield* annotateFireOutcome(skipped);
    return skipped;
  }
);
