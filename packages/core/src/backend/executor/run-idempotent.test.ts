/**
 * `runIdempotent` on the database executor's runtime, over a stubbed
 * repository: a step that stores nothing, whose failures the release counts
 * and backs off from as it does for a memoized step.
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
 * step `STEP`, over the memo rows `memo`. The body ends the run when the step
 * answers, and records the error it threw otherwise. Every memo write, and
 * every store write, dies: an idempotent step makes none of them.
 */
async function runPass(input: {
  memo: StepMemoEntry[];
  fn: () => Promise<string>;
}) {
  const releases: PassOutcome[] = [];
  const thrown: unknown[] = [];
  const unexpected = (name: string) => () =>
    Effect.die(new Error(`The pass's ${name} was not expected`));
  const writes: FencedExecutionWrites = {
    ...buildStoreWrites((name) => unexpected(name)),
    renewLease: unexpected("renewLease"),
    writeStepMemo: unexpected("writeStepMemo"),
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
                  runtime.runIdempotent(STEP, input.fn).catch((error) => {
                    thrown.push(error);
                  })
                ).pipe(Effect.as({ kind: "ended" } as const)),
            } as const),
          fail: () => Effect.die(new Error("No run was failed")),
        },
        delivery: unclaimed<DeliveryPass>(),
        cron: unclaimed<CronPass>(),
      },
      { workerId: "worker_1", now: () => NOW, leaseMs: 60_000 }
    ).pipe(Effect.provide(services))
  );
  return { result, releases, thrown };
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
    });
    expect(second).toEqual(first);
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
