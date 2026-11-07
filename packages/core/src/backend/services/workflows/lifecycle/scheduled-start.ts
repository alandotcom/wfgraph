/**
 * A scheduled run: a manual run of the published version that names no Event,
 * started when a cron timer falls due. `fireSchedule` runs the preflight a
 * manual start runs, then fires the timer through `ExecutionDriver`, whose one
 * fenced transaction opens the run, or records a Refused Start, and moves the
 * timer to its next slot. A pass that lost its timer's lease fails `LeaseLost`.
 */

import { Effect, Schema } from "effect";
import type { CronSchedule } from "@wfgraph/shared/lifecycle/cron-schedule";
import { emptyLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { ExecutionDriver } from "#src/backend/services/executions/driver";
import { runWorkflowExecutionPreflight } from "#src/backend/services/executions/preflight";
import {
  type CronFence,
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
 * How many times one fire checks the published version again after finding
 * that a Publish or a mode change moved it since its preflight. A fire that
 * still finds it moved fails, and the pass retries it after a backoff.
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
 * What one fire did.
 *
 * - `started`: it opened a run for `slot`, superseding `superseded` runs under
 *   newest-wins; `failedToSupersede` names those whose timeline entry the
 *   database refused.
 * - `refused`: first-wins deferred to the runs in flight, and the fire
 *   recorded a Refused Start for `slot`.
 * - `skipped`: the published graph cannot run, so the timer moved on to
 *   `nextWakeAt` without firing, recording `error`.
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
  | { kind: "skipped"; nextWakeAt: Date; error: string }
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
    // The slot is not run: the timer moves on and records why.
    const skip = (error: string) =>
      Effect.map(
        executions.skipCronSlot({ fence, schedule, error, now: input.now() }),
        (nextWakeAt): ScheduleFireOutcome => ({
          kind: "skipped",
          nextWakeAt,
          error,
        })
      );

    for (let attempt = 1; ; attempt += 1) {
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
        return yield* skip(preflight.error);
      }
      // Publish refuses a schedule on a graph with an Event Split, so this
      // answers a version published before that rule.
      if (preflight.checked.hasEventSplit) {
        return yield* skip(EVENT_SPLIT_ERROR);
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
        expected: {
          versionId: version.id,
          mode: workflow.mode,
          schedules: rules.schedules ?? [],
        },
        start: request,
        refusedEntry: {
          message: buildIgnoredRunAuditMessage({
            startSource: "schedule",
            reason: "concurrency_first_wins",
          }),
          metadata: omitUndefined({
            reason: "concurrency_first_wins",
            startSource: "schedule",
            entityValue,
            runMode: workflow.mode,
            schedule: { cron: schedule.cron, timeZone: schedule.timeZone },
          }),
        },
        now: input.now(),
      });

      if (fired.kind === "stale") {
        if (attempt < STALE_FIRE_ATTEMPTS) continue;
        return yield* new PublicationKeptMoving({
          message:
            "The published version or the Published mode changed during every fire attempt",
        });
      }
      if (fired.kind === "dropped") {
        const dropped: ScheduleFireOutcome = fired;
        return dropped;
      }
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
    }
  }
);
