// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import type { CronSchedule } from "@wfgraph/shared/lifecycle/cron-schedule";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { PublishedWorkflowVersion } from "#src/backend/lib/db/schema";
import {
  SilentAppLoggerLayer,
  stubExecutionDriver,
  stubExecutionRepo,
  stubExtensions,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import type {
  CronFence,
  CronFire,
  CronRefusedEntry,
  FireCronTimerInput,
  WorkflowExecution,
} from "#src/backend/services/executions/repo";
import { fireSchedule } from "#src/backend/services/workflows/lifecycle/scheduled-start";

const EVERY_FIVE: CronSchedule = { cron: "*/5 * * * *", timeZone: "UTC" };
const FENCE: CronFence = {
  scheduleId: "sched_1",
  workflowId: "wf_1",
  ownerToken: "tok_1",
};
const NOW = new Date("2026-03-01T09:05:30.000Z");
/** The latest slot of `EVERY_FIVE` at or before `NOW`. */
const SLOT = new Date("2026-03-01T09:05:00.000Z");

const scheduledRules: LifecycleRules = {
  startEvents: [],
  cancelEvents: [],
  concurrency: "first-wins",
  schedules: [EVERY_FIVE],
};

/**
 * A graph whose entry node declares `scheduledRules`. With `unknownEvent`, it
 * also names a Start Event the app does not define, which the preflight
 * refuses.
 */
function graph(input: { unknownEvent?: boolean } = {}) {
  const rules: LifecycleRules =
    input.unknownEvent === true
      ? { ...scheduledRules, startEvents: ["app/not-in-the-catalog"] }
      : scheduledRules;
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "entry",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          type: "lifecycle",
          label: "Nightly report",
          config: { lifecycleRules: rules },
        },
      },
    ],
    edges: [],
  });
}

function version(
  id: string,
  versionGraph: SerializedWorkflowGraph
): PublishedWorkflowVersion {
  return {
    id,
    workflowId: "wf_1",
    version: Number(id.slice("ver_".length)),
    kind: "published",
    graph: versionGraph,
    catalogFingerprint: "fp",
    graphDigest: `digest-${id}`,
    publishedAt: new Date("2026-02-01T00:00:00.000Z"),
    lastPinnedAt: null,
  };
}

function execution(id: string): WorkflowExecution {
  return {
    id,
    workflowId: "wf_1",
    workflowVersionId: "ver_2",
    deliveryId: null,
    status: "running",
    startSource: "schedule",
    runMode: "live",
    startEventName: null,
    entityValue: "workflow:wf_1",
    entityType: null,
    entityId: null,
    input: {},
    output: null,
    error: null,
    startedAt: NOW,
    scheduledFor: SLOT,
    waitingAt: null,
    cancelledAt: null,
    completedAt: null,
    duration: null,
    terminationKind: null,
    terminationRequestedAt: null,
    terminationReason: null,
    terminationNodeId: null,
    cancelEventName: null,
    cancelPayload: null,
  };
}

/**
 * The services a fire reads, over `versions`, the version the workflow
 * publishes at each read, and `fires`, what each fire answers in turn.
 */
function makeServices(input: {
  versions: PublishedWorkflowVersion[];
  fires: CronFire[];
}) {
  const reads = { versions: 0 };
  const fired: FireCronTimerInput[] = [];
  const skipped: {
    error: string;
    now: Date;
    refusal: ReturnType<CronRefusedEntry>;
  }[] = [];
  const provided = Layer.mergeAll(
    SilentAppLoggerLayer,
    stubExtensions(),
    stubIntegrationRepo(),
    stubWorkflowRepo({
      findByIdWithPublishedVersionForRun: () =>
        Effect.sync(() => {
          const published =
            input.versions[Math.min(reads.versions, input.versions.length - 1)];
          reads.versions += 1;
          return {
            workflow: {
              id: "wf_1",
              name: "Nightly report",
              mode: "live" as const,
              isPaused: false,
            },
            publishedVersion: published ?? null,
          };
        }),
      findVersionById: (versionId) =>
        Effect.succeed(
          input.versions.find((each) => each.id === versionId) ?? null
        ),
    }),
    stubExecutionRepo({
      skipCronSlot: (skip) =>
        Effect.sync(() => {
          skipped.push({
            error: skip.error,
            now: skip.now,
            refusal: skip.refusedEntry(SLOT),
          });
          return {
            slot: SLOT,
            nextWakeAt: new Date("2026-03-01T09:10:00.000Z"),
          };
        }),
    }),
    stubExecutionDriver({
      fireCronTimer: (fire) =>
        Effect.sync(() => {
          const answer = input.fires[fired.length];
          fired.push(fire);
          if (!answer) throw new Error("No fire was expected");
          return answer;
        }),
    })
  );
  return { provided, reads, fired, skipped };
}

const firedRun: CronFire = {
  kind: "fired",
  slot: SLOT,
  nextWakeAt: new Date("2026-03-01T09:10:00.000Z"),
  start: {
    status: "started",
    execution: execution("exec_1"),
    supersededExecutionIds: [],
  },
};

describe("fireSchedule", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect(
      "fires the published version as a start naming no Event, for the workflow's own entity",
      () =>
        Effect.gen(function* () {
          const services = makeServices({
            versions: [version("ver_2", graph())],
            fires: [firedRun],
          });

          const outcome = yield* fireSchedule({
            fence: FENCE,
            schedule: EVERY_FIVE,
            now: () => NOW,
          }).pipe(Effect.provide(services.provided));

          assert.deepStrictEqual(outcome, {
            kind: "started",
            executionId: "exec_1",
            versionId: "ver_2",
            slot: SLOT,
            nextWakeAt: new Date("2026-03-01T09:10:00.000Z"),
            superseded: 0,
            failedToSupersede: [],
          });
          const [request] = services.fired;
          assert.deepStrictEqual(request?.expected, {
            versionId: "ver_2",
            mode: "live",
            schedules: [EVERY_FIVE],
          });
          assert.deepStrictEqual(request?.start.execution, {
            workflowId: "wf_1",
            workflowVersionId: "ver_2",
            startSource: "schedule",
            runMode: "live",
            startEventName: undefined,
            input: {},
            deliveryId: undefined,
            entityValue: "workflow:wf_1",
          });
          assert.strictEqual(request?.start.concurrency, "first-wins");
          // The schedule reads time in UTC, so the 09:05 UTC slot is 9:05 AM.
          assert.deepStrictEqual(request?.refusedEntry(SLOT), {
            message:
              "Refused the 9:05 AM scheduled run: a run is still going and Concurrency is first-wins",
            metadata: {
              entityValue: "workflow:wf_1",
              runMode: "live",
              reason: "concurrency_first_wins",
              startSource: "schedule",
              schedule: EVERY_FIVE,
              scheduledFor: "2026-03-01T09:05:00.000Z",
            },
          });
          assert.strictEqual(request?.now, NOW);
        })
    );

    it.effect(
      "checks the version again and fires again when the fire finds it moved since the preflight",
      () =>
        Effect.gen(function* () {
          const services = makeServices({
            versions: [version("ver_1", graph()), version("ver_2", graph())],
            fires: [{ kind: "stale" }, firedRun],
          });

          const outcome = yield* fireSchedule({
            fence: FENCE,
            schedule: EVERY_FIVE,
            now: () => NOW,
          }).pipe(Effect.provide(services.provided));

          assert.strictEqual(outcome.kind, "started");
          assert.strictEqual(services.reads.versions, 2);
          assert.deepStrictEqual(
            services.fired.map((fire) => fire.expected.versionId),
            ["ver_1", "ver_2"]
          );
        })
    );

    it.effect(
      "skips the slot, firing nothing, when the published graph no longer passes the preflight",
      () =>
        Effect.gen(function* () {
          const services = makeServices({
            versions: [version("ver_3", graph({ unknownEvent: true }))],
            fires: [],
          });

          const outcome = yield* fireSchedule({
            fence: FENCE,
            schedule: EVERY_FIVE,
            now: () => NOW,
          }).pipe(Effect.provide(services.provided));

          assert.strictEqual(outcome.kind, "skipped");
          assert.strictEqual(services.fired.length, 0);
          assert.strictEqual(services.skipped.length, 1);
          const [skip] = services.skipped;
          assert.deepStrictEqual(skip?.now, NOW);
          // The skip writes a Refused Start a builder reads in the Runs view,
          // and keeps the preflight's own error on its metadata.
          assert.strictEqual(
            skip?.refusal.message,
            "Refused the 9:05 AM scheduled run: the published version no longer passes the checks a run starts with"
          );
          assert.deepStrictEqual(skip?.refusal.metadata, {
            versionId: "ver_3",
            runMode: "live",
            error: skip?.error ?? "",
            reason: "published_version_not_runnable",
            startSource: "schedule",
            schedule: EVERY_FIVE,
            scheduledFor: "2026-03-01T09:05:00.000Z",
          });
        })
    );
  });
});
