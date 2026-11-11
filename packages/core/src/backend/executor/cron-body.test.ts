/**
 * A cron row's pass over stubbed repositories, for the endings no database
 * case reaches: a fire whose publication keeps moving, a fire that finds its
 * lease lost, and a body failure that spends the row's last retry.
 */

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { CronSchedule } from "@wfgraph/shared/lifecycle/cron-schedule";
import type { PublishedWorkflowVersion } from "#src/backend/lib/db/schema";
import { DatabaseError, LeaseLost } from "#src/backend/lib/effect/database";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubExtensions,
  stubIntegrationRepo,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { cronBody } from "#src/backend/executor/cron-body";
import {
  type DeliveryPass,
  leasedPass,
  type PassBody,
  type RunPass,
} from "#src/backend/executor/pass";
import { recordingLogger } from "#src/backend/executor/testing/recorded-logger";
import { makeExecutionDriverLayer } from "#src/backend/services/executions/driver";
import type {
  ClaimedCron,
  CronFire,
  CronPassWrites,
  PassOutcome,
  SkipCronSlotInput,
} from "#src/backend/services/executions/repo";
import {
  retryBackoffMs,
  STEP_RETRY_LIMIT,
} from "#src/backend/services/executions/repo/release-policy";

const EVERY_FIVE: CronSchedule = { cron: "*/5 * * * *", timeZone: "UTC" };
const NOW = new Date("2026-03-01T09:05:30.000Z");

const VERSION: PublishedWorkflowVersion = {
  id: "ver_1",
  workflowId: "wf_1",
  version: 1,
  kind: "published",
  graph: createSerializedWorkflowGraph({
    nodes: [
      {
        id: "entry",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          type: "lifecycle",
          label: "Nightly report",
          config: {
            lifecycleRules: {
              startEvents: [],
              cancelEvents: [],
              concurrency: "first-wins",
              schedules: [EVERY_FIVE],
            },
          },
        },
      },
    ],
    edges: [],
  }),
  catalogFingerprint: "fp",
  graphDigest: "digest",
  publishedAt: new Date("2026-02-01T00:00:00.000Z"),
  lastPinnedAt: null,
};

function claimed(attempt: number, wakeAt: Date): ClaimedCron {
  return {
    kind: "cron",
    scheduleId: "sched_1",
    ownerToken: "tok_1",
    attempt,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    workflowId: "wf_1",
    schedule: EVERY_FIVE,
    wakeAt,
  };
}

/** The slot `NOW` falls in, which a timer claimed at `NOW` was due at. */
const DUE_SLOT = new Date("2026-03-01T09:05:00.000Z");

/** A body for a kind of row these cases never claim. */
function unclaimed<P>(): PassBody<P, never> {
  return {
    open: () => Effect.die(new Error("No such row was claimed")),
    fail: () => Effect.die(new Error("No such row was claimed")),
  };
}

const bodies = {
  run: unclaimed<RunPass>(),
  delivery: unclaimed<DeliveryPass>(),
  cron: cronBody(),
};

/**
 * Runs one leased pass over the cron row `claimed(attempt)`, whose writes
 * answer the fire with `fire` and record every release and skip. The
 * workflow publishes `VERSION` at every read unless `loadFails`, when the read
 * fails as the database would, or `deleted`, when the read finds no workflow
 * and the fence finds the timer row gone with it.
 */
async function runPass(input: {
  attempt: number;
  fire: () => Effect.Effect<CronFire, DatabaseError | LeaseLost>;
  loadFails?: boolean | undefined;
  deleted?: boolean | undefined;
  /** The slot the timer was due at; `DUE_SLOT` when omitted. */
  wakeAt?: Date | undefined;
}) {
  const fires: number[] = [];
  const releases: PassOutcome[] = [];
  const skips: SkipCronSlotInput[] = [];
  const drops: number[] = [];
  const unexpected = (name: string) => () =>
    Effect.die(new Error(`The pass's ${name} was not expected`));
  const writes: CronPassWrites = {
    renewLease: unexpected("renewLease"),
    writeStepMemo: unexpected("writeStepMemo"),
    dropSchedule: () =>
      Effect.suspend(() => {
        drops.push(drops.length + 1);
        return input.deleted === true
          ? Effect.fail(new LeaseLost({ message: "row gone" }))
          : Effect.die(new Error("The pass's dropSchedule was not expected"));
      }),
    releasePass: (release) =>
      Effect.sync(() => {
        releases.push(release.outcome);
        return {
          schedule: { state: "queued", wakeAt: release.now, attempt: 1 },
          countedStep: null,
        };
      }),
    fireCronTimer: () =>
      Effect.suspend(() => {
        fires.push(fires.length + 1);
        return input.fire();
      }),
    skipCronSlot: (skip) =>
      Effect.sync(() => {
        skips.push(skip);
        return { kind: "skipped" as const };
      }),
  };
  const executions = stubExecutionRepo({ fencedCron: () => writes });
  const recording = recordingLogger();
  const services = Layer.mergeAll(
    executions,
    makeExecutionDriverLayer([]).pipe(Layer.provide(executions)),
    SilentAppLoggerLayer,
    stubExtensions(),
    stubIntegrationRepo(),
    stubWorkflowRepo({
      findByIdWithPublishedVersionForRun: () =>
        input.loadFails === true
          ? Effect.fail(new DatabaseError({ cause: new Error("down") }))
          : input.deleted === true
            ? Effect.succeed(null)
            : Effect.succeed({
                workflow: {
                  id: "wf_1",
                  name: "Nightly report",
                  mode: "live" as const,
                  isPaused: false,
                },
                publishedVersion: VERSION,
              }),
      findVersionById: () => Effect.succeed(VERSION),
    }),
    recording.layer
  );
  const result = await Effect.runPromise(
    leasedPass(claimed(input.attempt, input.wakeAt ?? DUE_SLOT), bodies, {
      workerId: "worker_1",
      now: () => NOW,
      leaseMs: 60_000,
    }).pipe(Effect.provide(services))
  );
  return { result, fires, releases, skips, drops, lines: recording.lines };
}

describe("cron pass", () => {
  // The timer last fired 09:05 and moved on to 09:10, and the worker that
  // claimed it at 09:10 reads 09:05:30 when it fires, as a clock stepped back
  // would.
  it("never reads a slot earlier than the one the timer was claimed at", async () => {
    const pass = await runPass({
      attempt: STEP_RETRY_LIMIT,
      fire: () => Effect.die(new Error("No fire was expected")),
      loadFails: true,
      wakeAt: new Date("2026-03-01T09:10:00.000Z"),
    });

    expect(pass.skips).toEqual([
      expect.objectContaining({
        nextWakeAt: new Date("2026-03-01T09:15:00.000Z"),
        refusedEntry: expect.objectContaining({
          metadata: expect.objectContaining({
            scheduledFor: "2026-03-01T09:10:00.000Z",
          }),
        }),
      }),
    ]);
  });

  it("fails a fire whose publication moved on every check, and releases the row after a backoff", async () => {
    const pass = await runPass({
      attempt: 0,
      fire: () => Effect.succeed({ kind: "stale" }),
    });

    expect(pass.fires).toHaveLength(3);
    expect(pass.releases).toEqual([
      {
        kind: "body_failed",
        error: expect.stringContaining("changed during every fire attempt"),
        backoffMs: retryBackoffMs(0),
      },
    ]);
    expect(pass.result).toMatchObject({
      kind: "retry",
      schedule: { state: "queued", attempt: 1 },
    });
  });

  it("stops a fire whose fence refuses it as a lost lease, and writes no release", async () => {
    const pass = await runPass({
      attempt: 0,
      fire: () => Effect.fail(new LeaseLost({ message: "lease taken" })),
    });

    expect(pass.fires).toHaveLength(1);
    expect(pass.result).toEqual({ kind: "fence_refused", fence: "owner" });
    expect(pass.releases).toEqual([]);
    expect(pass.skips).toEqual([]);
  });

  it("ends a pass whose workflow was deleted after the claim as a lost lease, with no release and no error record", async () => {
    const pass = await runPass({
      attempt: 0,
      fire: () => Effect.die(new Error("No fire was expected")),
      deleted: true,
    });

    expect(pass.drops).toHaveLength(1);
    expect(pass.result).toEqual({ kind: "fence_refused", fence: "owner" });
    expect(pass.releases).toEqual([]);
    expect(pass.skips).toEqual([]);
    expect(pass.fires).toEqual([]);
    // The pass's own lease-lost record, a warning, and nothing else.
    expect(pass.lines).toEqual([
      {
        message: "Executor pass did not settle its row",
        annotations: expect.objectContaining({
          outcome: { kind: "lease_lost" },
        }),
      },
    ]);
  });

  it("skips the slot when a failure spends the row's last retry, with the fire's one record", async () => {
    const pass = await runPass({
      attempt: STEP_RETRY_LIMIT,
      fire: () => Effect.die(new Error("No fire was expected")),
      loadFails: true,
    });

    expect(pass.result).toMatchObject({ kind: "subject_failed" });
    expect(pass.fires).toEqual([]);
    expect(pass.releases).toEqual([]);
    expect(pass.skips).toEqual([
      expect.objectContaining({
        error: expect.stringContaining("down"),
        nextWakeAt: new Date("2026-03-01T09:10:00.000Z"),
        refusedEntry: expect.objectContaining({
          metadata: expect.objectContaining({
            reason: "scheduled_start_failed",
            scheduledFor: "2026-03-01T09:05:00.000Z",
          }),
        }),
      }),
    ]);
    const records = pass.lines.filter(
      (line) =>
        line.message === "Skipped a cron slot" ||
        line.message === "Executor pass did not settle its row"
    );
    expect(records).toEqual([
      {
        message: "Skipped a cron slot",
        annotations: expect.objectContaining({
          cron: expect.objectContaining({
            workflow: "wf_1",
            slot: new Date("2026-03-01T09:05:00.000Z"),
          }),
          outcome: { kind: "skipped", nextWakeAt: expect.any(Date) },
        }),
      },
    ]);
  });
});
