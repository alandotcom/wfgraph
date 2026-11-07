/**
 * `fireSchedule` starts a scheduled run, a run of the published version that
 * names no Event, when a cron timer falls due. It runs a manual start's
 * preflight, then `ExecutionDriver.fireCronTimer` opens the run or records a
 * Refused Start and moves the timer on, in one transaction fenced on the lease.
 * An unrunnable slot gets a Refused Start; a lost lease fails `LeaseLost`.
 */

import { Effect, Schema } from "effect";
import type { CronSchedule } from "@wfgraph/shared/lifecycle/cron-schedule";
import type { WorkflowExecutionIgnoredReason } from "@wfgraph/shared/lifecycle/execution-contracts";
import { emptyLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { encodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";
import { ExecutionDriver } from "#src/backend/services/executions/driver";
import { runWorkflowExecutionPreflight } from "#src/backend/services/executions/preflight";
import {
  type CronFence,
  type CronPublication,
  type CronRefusal,
  type CronRefusedEntry,
  ExecutionRepo,
} from "#src/backend/services/executions/repo";
import {
  buildIgnoredRunAuditMessage,
  toWorkflowRunTarget,
} from "#src/backend/services/executions/run-rows";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  announceDisplacedRuns,
  startRequestFor,
} from "#src/backend/services/workflows/lifecycle/concurrency";

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

/** The sentence a fire records when the slot cannot run the graph. */
const EVENT_SPLIT_ERROR =
  "This workflow splits on the Event a run is on, and a scheduled run names none";

/**
 * The Refused Start for a slot of `schedule` that does not run, for `reason`,
 * worded with the slot's time in the schedule's zone. `extra` is what one
 * reason knows and the others do not, such as the preflight's error, and it
 * stays on the row's metadata.
 */
export function scheduledRefusal(input: {
  schedule: CronSchedule;
  reason: WorkflowExecutionIgnoredReason;
  extra?: JsonObject | undefined;
}): CronRefusedEntry {
  const { schedule, reason } = input;
  return (slot) => ({
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
  });
}

/**
 * What one fire did.
 *
 * - `started`: it opened a run for `slot`, superseding `superseded` runs under
 *   newest-wins; `failedToSupersede` names those whose timeline entry the
 *   database refused.
 * - `refused`: first-wins deferred to the runs in flight, and the fire
 *   recorded a Refused Start for `slot`.
 * - `skipped`: the published graph cannot run, so the fire recorded a Refused
 *   Start for `slot` and moved the timer on to `nextWakeAt`, recording `error`.
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
      failedToSupersede: string[];
    }
  | {
      kind: "refused";
      versionId: string;
      slot: Date;
      nextWakeAt: Date;
      inFlightExecutionIds: string[];
    }
  | { kind: "skipped"; slot: Date; nextWakeAt: Date; error: string }
  | {
      kind: "dropped";
      reason: "workflow_paused" | "not_published" | "schedule_unpublished";
    };

/** Fires the leased timer `fence` names for `schedule`, at the pass's clock `now`. */
export const fireSchedule = Effect.fn("wfgraph.schedule.fire")(
  function* (input: {
    fence: CronFence;
    schedule: CronSchedule;
    now: () => Date;
  }) {
    const { fence, schedule } = input;
    const workflows = yield* WorkflowRepo;
    const executions = yield* ExecutionRepo;
    const driver = yield* ExecutionDriver;
    // The slot is not run: a Refused Start says so, and the timer moves on and
    // records why. The skip writes it only while the workflow still publishes
    // `expected`, so a Publish that repaired the graph since the preflight
    // gets its slot fired instead.
    const skip = (error: string, expected: CronPublication) =>
      Effect.map(
        executions.skipCronSlot({
          fence,
          schedule,
          expected,
          error,
          refusedEntry: scheduledRefusal({
            schedule,
            reason: "published_version_not_runnable",
            extra: {
              versionId: expected.versionId,
              runMode: expected.mode,
              error,
            },
          }),
          now: input.now(),
        }),
        (skipped): ScheduleFireOutcome | CronRefusal =>
          skipped.kind === "skipped" ? { ...skipped, error } : skipped
      );

    // One check of the published version, ending in one fire or one skip.
    // `stale` means the version or the mode moved since the preflight.
    const attempt = Effect.gen(function* () {
      const loaded = yield* workflows.findByIdWithPublishedVersionForRun(
        fence.workflowId
      );
      // Publish writes a timer only for a published version, and a timer
      // cascades with its workflow, so this answers a row that should not
      // exist. A row the cascade already took refuses the drop as a lost lease.
      if (!loaded?.publishedVersion) {
        yield* executions.fencedPass(fence).dropSchedule();
        const dropped: ScheduleFireOutcome = {
          kind: "dropped",
          reason: "not_published",
        };
        return dropped;
      }
      const { workflow, publishedVersion: version } = loaded;
      const expected: CronPublication = {
        versionId: version.id,
        mode: workflow.mode,
      };

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
        return yield* skip(preflight.error, expected);
      }
      // Publish refuses a schedule on a graph with an Event Split, so this
      // answers a version published before that rule.
      if (preflight.checked.hasEventSplit) {
        return yield* skip(EVENT_SPLIT_ERROR, expected);
      }

      const rules = preflight.checked.lifecycleRules ?? emptyLifecycleRules;
      const entityValue = `workflow:${workflow.id}`;
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
        fence,
        schedule,
        expected: { ...expected, schedules: rules.schedules ?? [] },
        start: request,
        refusedEntry: scheduledRefusal({
          schedule,
          reason: "concurrency_first_wins",
          extra: { entityValue, runMode: workflow.mode },
        }),
        now: input.now(),
      });

      if (fired.kind !== "fired") return fired;
      if (fired.start.status === "refused") {
        const refused: ScheduleFireOutcome = {
          kind: "refused",
          versionId: version.id,
          slot: fired.slot,
          nextWakeAt: fired.nextWakeAt,
          inFlightExecutionIds: fired.start.inFlightExecutionIds,
        };
        return refused;
      }

      const { execution, supersededExecutionIds } = fired.start;
      const announced = yield* announceDisplacedRuns({
        workflowId: workflow.id,
        supersededExecutionIds,
      });
      const started: ScheduleFireOutcome = {
        kind: "started",
        executionId: execution.id,
        versionId: version.id,
        slot: fired.slot,
        nextWakeAt: fired.nextWakeAt,
        superseded: supersededExecutionIds.length,
        failedToSupersede: announced.failedExecutionIds,
      };
      return started;
    });

    for (let tries = 0; tries < STALE_FIRE_ATTEMPTS; tries += 1) {
      const outcome = yield* attempt;
      if (outcome.kind !== "stale") return outcome;
    }
    return yield* new PublicationKeptMoving({
      message:
        "The published version or the Published mode changed during every fire attempt",
    });
  }
);
