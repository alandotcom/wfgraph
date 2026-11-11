/**
 * `runIdempotent` on the database executor's runtime, over a stubbed
 * repository: a step that stores no value, whose failures the release counts
 * and backs off from as it does for a memoized step, and which the heartbeat
 * never records as running.
 */

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import type { DurableStepRef } from "#src/backend/engine/runtime";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  type DeliveryPass,
  type CronPass,
  leasedPass,
  type PassBody,
} from "#src/backend/executor/pass";
import type {
  ClaimedRun,
  FencedExecutionWrites,
  PassOutcome,
  StepMemoEntry,
} from "#src/backend/services/executions/repo";
import { buildStoreWrites } from "#src/backend/services/executions/repo/fencing";
import {
  retryBackoffMs,
  STEP_RETRY_LIMIT,
} from "#src/backend/services/executions/repo/release-policy";

const NOW = new Date("2026-03-01T09:00:00.000Z");

const STEP: DurableStepRef = {
  id: "node:send:log-open",
  nodeId: "send",
  name: "Send (open)",
};

const CLAIMED: ClaimedRun = {
  kind: "run",
  scheduleId: "sched_1",
  ownerToken: "tok_1",
  attempt: 0,
  leaseExpiresAt: new Date(NOW.getTime() + 60_000),
  executionId: "exec_1",
};

/** A body for a kind of row these cases never claim. */
function unclaimed<P>(): PassBody<P, never> {
  return {
    open: () => Effect.die(new Error("No such row was claimed")),
    fail: () => Effect.die(new Error("No such row was claimed")),
  };
}

/**
 * Runs one leased pass over `CLAIMED` whose body runs `fn` as the idempotent
 * step `STEP`, over the memo rows `memo`, with a heartbeat every
 * `heartbeatMs` when given. The body ends the run when the step answers, and
 * records the error it threw otherwise. The pass records each memo write and
 * the running step of each lease renewal; every store write dies.
 */
async function runPass(input: {
  memo: StepMemoEntry[];
  fn: (beats: Array<string | null>) => Promise<string>;
  heartbeatMs?: number | undefined;
}) {
  const releases: PassOutcome[] = [];
  const thrown: unknown[] = [];
  const memoWrites: Array<{ stepId: string; value: unknown }> = [];
  const beats: Array<string | null> = [];
  const unexpected = (name: string) => () =>
    Effect.die(new Error(`The pass's ${name} was not expected`));
  const writes: FencedExecutionWrites = {
    ...buildStoreWrites((name) => unexpected(name)),
    renewLease: (renewal) =>
      Effect.sync(() => {
        beats.push(renewal.runningStepId);
      }),
    writeStepMemo: (memo) =>
      Effect.sync(() => {
        memoWrites.push({ stepId: memo.stepId, value: memo.value });
      }),
    dropSchedule: unexpected("dropSchedule"),
    recordParkStep: unexpected("recordParkStep"),
    releasePass: (release) =>
      Effect.sync(() => {
        releases.push(release.outcome);
        return {
          schedule: { state: "queued", wakeAt: release.now, attempt: 0 },
          countedStep: null,
        };
      }),
  };
  const services = Layer.mergeAll(
    stubExecutionRepo({
      fenced: () => writes,
      listStepMemo: () => Effect.succeed(input.memo),
    }),
    SilentAppLoggerLayer
  );
  const result = await Effect.runPromise(
    leasedPass(
      CLAIMED,
      {
        run: {
          open: () =>
            Effect.succeed({
              kind: "ready",
              run: (runtime) =>
                Effect.promise(() =>
                  runtime
                    .runIdempotent(STEP, () => input.fn(beats))
                    .catch((error) => {
                      thrown.push(error);
                    })
                ).pipe(Effect.as({ kind: "ended" } as const)),
            } as const),
          fail: () => Effect.die(new Error("No run was failed")),
        },
        delivery: unclaimed<DeliveryPass>(),
        cron: unclaimed<CronPass>(),
      },
      {
        workerId: "worker_1",
        now: () => NOW,
        leaseMs: 60_000,
        heartbeatMs: input.heartbeatMs,
      }
    ).pipe(Effect.provide(services))
  );
  return { result, releases, thrown, memoWrites, beats };
}

/** Waits until `beats` holds at least `count` lease renewals. */
async function untilBeats(beats: Array<string | null>, count: number) {
  while (beats.length < count) {
    // eslint-disable-next-line eslint/no-await-in-loop -- polls the heartbeat the pass runs beside this step
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("runIdempotent on the database executor", () => {
  it("runs the step on every pass and stores nothing when it succeeds", async () => {
    let calls = 0;
    const fn = () => {
      calls += 1;
      return Promise.resolve("opened");
    };

    const first = await runPass({ memo: [], fn });
    const second = await runPass({ memo: [], fn });

    expect(calls).toBe(2);
    expect(first).toEqual({
      result: { kind: "ended" },
      releases: [],
      thrown: [],
      memoWrites: [],
      beats: [],
    });
    expect(second).toEqual(first);
  });

  it("marks a failing memo row succeeded when the step succeeds", async () => {
    const pass = await runPass({
      memo: [
        {
          stepId: STEP.id,
          nodeId: "send",
          status: "failing",
          failures: 1,
          error: "connection reset",
        },
      ],
      fn: () => Promise.resolve("opened"),
    });

    expect(pass.memoWrites).toEqual([{ stepId: STEP.id, value: null }]);
    expect(pass.releases).toEqual([]);
    expect(pass.thrown).toEqual([]);
  });

  it("is never the step the heartbeat records as running", async () => {
    const pass = await runPass({
      memo: [],
      heartbeatMs: 1,
      fn: async (beats) => {
        await untilBeats(beats, 2);
        return "opened";
      },
    });

    expect(pass.beats.length).toBeGreaterThanOrEqual(2);
    expect(pass.beats.filter((step) => step !== null)).toEqual([]);
  });

  it("counts a failure against the step and backs off by the failures its memo row already holds", async () => {
    const pass = await runPass({
      memo: [
        {
          stepId: STEP.id,
          nodeId: "send",
          status: "failing",
          failures: 2,
          error: "connection reset",
        },
      ],
      fn: () => Promise.reject(new Error("connection reset again")),
    });

    expect(pass.releases).toEqual([
      {
        kind: "step_failed",
        stepId: STEP.id,
        nodeId: "send",
        error: "connection reset again",
        backoffMs: retryBackoffMs(2),
        retriable: true,
      },
    ]);
    expect(pass.result).toMatchObject({
      kind: "retry",
      error: "connection reset again",
    });
  });

  it("refuses a step whose retries are spent before calling it, with the error its memo row holds", async () => {
    let calls = 0;
    const pass = await runPass({
      memo: [
        {
          stepId: STEP.id,
          nodeId: "send",
          status: "failed",
          failures: STEP_RETRY_LIMIT + 1,
          error: "connection reset",
        },
      ],
      fn: () => {
        calls += 1;
        return Promise.resolve("opened");
      },
    });

    expect(calls).toBe(0);
    expect(pass.thrown).toEqual([
      expect.objectContaining({ message: "connection reset" }),
    ]);
    expect(pass.releases).toEqual([]);
  });
});
