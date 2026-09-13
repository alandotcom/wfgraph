// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { Effect, Layer } from "effect";
import {
  InngestError,
  type InngestClient,
} from "#src/backend/lib/effect/inngest-client";
import {
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import { DatabaseError } from "#src/backend/lib/effect/database";
import type {
  ExecutionRepo,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import { resumeWaitByToken } from "#src/backend/services/workflows/lifecycle/resume";

const RESUME_TOKEN = "resume_token_1";
const CLAIMED_AT = new Date("2026-03-01T00:01:00.000Z");

const liveWaitState: WorkflowWaitState = {
  id: "wait_1",
  executionId: "exec_1",
  workflowId: "wf_1",
  runId: "run_1",
  nodeId: "node_wait",
  nodeName: "Wait for approval",
  waitType: "event",
  status: "waiting",
  resumeToken: RESUME_TOKEN,
  waitUntil: null,
  subscribedEvents: ["appointment.confirmed"],
  metadata: null,
  createdAt: new Date("2026-03-01T00:00:00.000Z"),
  resumedAt: null,
  cancelledAt: null,
};

function makeResumeSeams(input: {
  waitState?: WorkflowWaitState | undefined;
  sendWaitSignal?: InngestClient["Service"]["sendWaitSignal"] | undefined;
  /** What `settleWaitingStateClaim` answers. Defaults to the claim settling. */
  settled?: boolean | undefined;
  /**
   * The whole `settleWaitingStateClaim` seam, for a case that needs the write
   * to fail rather than to answer false.
   */
  settle?: ExecutionRepo["Service"]["settleWaitingStateClaim"] | undefined;
}) {
  const calls = {
    tokenLookups: [] as string[],
    claimed: false,
  };

  return {
    layer: Layer.mergeAll(
      stubExecutionRepo({
        claimWaitingStateByToken: ({ resumeToken }) =>
          Effect.sync(() => {
            calls.tokenLookups.push(resumeToken);
            if (calls.claimed || !input.waitState) {
              return null;
            }
            calls.claimed = true;
            return { waitState: input.waitState, claimedAt: CLAIMED_AT };
          }),
        releaseWaitingStateClaim: () =>
          Effect.sync(() => {
            if (!calls.claimed) {
              return false;
            }
            calls.claimed = false;
            return true;
          }),
        settleWaitingStateClaim:
          input.settle ?? (() => Effect.succeed(input.settled ?? true)),
      }),
      // Left refusing unless a test supplies one, so a send from a request that
      // should never have got this far kills the test.
      stubInngestClient(
        input.sendWaitSignal ? { sendWaitSignal: input.sendWaitSignal } : {}
      )
    ),
    calls,
  };
}

describe("resumeWaitByToken", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("claims the waiting node and sends its resume signal", () =>
      Effect.gen(function* () {
        const signals: Array<
          Parameters<InngestClient["Service"]["sendWaitSignal"]>[0]
        > = [];
        const seams = makeResumeSeams({
          waitState: liveWaitState,
          sendWaitSignal: (signal) =>
            Effect.sync(() => {
              signals.push(signal);
            }),
        });

        const resumed = yield* resumeWaitByToken({
          token: RESUME_TOKEN,
          body: { approved: true },
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(resumed, {
          success: true,
          status: "resumed",
          executionId: "exec_1",
        });
        assert.deepStrictEqual(signals, [
          {
            executionId: "exec_1",
            nodeId: "node_wait",
            token: RESUME_TOKEN,
            payload: { approved: true },
            signalType: "wait-resume",
          },
        ]);
      })
    );

    it.effect("lets only one concurrent caller send the resume signal", () =>
      Effect.gen(function* () {
        const signals: Array<
          Parameters<InngestClient["Service"]["sendWaitSignal"]>[0]
        > = [];
        const seams = makeResumeSeams({
          waitState: liveWaitState,
          sendWaitSignal: (signal) =>
            Effect.sync(() => {
              signals.push(signal);
            }),
        });

        const attempts = yield* Effect.forEach(
          [
            resumeWaitByToken({ token: RESUME_TOKEN, body: {} }),
            resumeWaitByToken({ token: RESUME_TOKEN, body: {} }),
          ],
          Effect.exit,
          { concurrency: "unbounded" }
        ).pipe(Effect.provide(seams.layer));

        assert.strictEqual(signals.length, 1);
        assert.strictEqual(
          attempts.filter((attempt) => attempt._tag === "Success").length,
          1
        );
        assert.strictEqual(
          attempts.filter((attempt) => attempt._tag === "Failure").length,
          1
        );
      })
    );

    // The signal is already with the durable runtime by the time the claim is
    // settled, so a settle another writer won is a run that did resume. Reading
    // it as a wait nobody could reach would answer 404 for a run that woke.
    it.effect("reports a resume whose claim another writer settled", () =>
      Effect.gen(function* () {
        const seams = makeResumeSeams({
          waitState: liveWaitState,
          sendWaitSignal: () => Effect.void,
          settled: false,
        });

        const resumed = yield* resumeWaitByToken({
          token: RESUME_TOKEN,
          body: { approved: true },
        }).pipe(Effect.provide(seams.layer));

        assert.deepStrictEqual(resumed, {
          success: true,
          status: "resumed",
          executionId: "exec_1",
        });
      })
    );

    // The durable runtime has the signal, so the run wakes whether or not this
    // bookkeeping write lands. The woken run settles the row itself, and a
    // failure here that reached the caller would report a failed resume for a
    // run that resumed.
    it.effect(
      "answers resumed when the settle write fails after the signal was accepted",
      () =>
        Effect.gen(function* () {
          const signals: Array<
            Parameters<InngestClient["Service"]["sendWaitSignal"]>[0]
          > = [];
          const seams = makeResumeSeams({
            waitState: liveWaitState,
            sendWaitSignal: (signal) =>
              Effect.sync(() => {
                signals.push(signal);
              }),
            settle: () =>
              Effect.fail(
                new DatabaseError({ cause: new Error("connection reset") })
              ),
          });

          const resumed = yield* resumeWaitByToken({
            token: RESUME_TOKEN,
            body: { approved: true },
          }).pipe(Effect.provide(seams.layer));

          assert.deepStrictEqual(resumed, {
            success: true,
            status: "resumed",
            executionId: "exec_1",
          });
          assert.strictEqual(signals.length, 1);
          // A released claim would return the row to `waiting`, where a second
          // wake could take it and send the signal again.
          assert.strictEqual(seams.calls.claimed, true);

          const second = yield* resumeWaitByToken({
            token: RESUME_TOKEN,
            body: { approved: true },
          }).pipe(Effect.provide(seams.layer), Effect.exit);

          assert.strictEqual(second._tag, "Failure");
          assert.strictEqual(signals.length, 1);
        })
    );

    it.effect("allows a retry when the wake signal is refused", () =>
      Effect.gen(function* () {
        let attempts = 0;
        const seams = makeResumeSeams({
          waitState: liveWaitState,
          sendWaitSignal: () =>
            Effect.suspend(() => {
              attempts += 1;
              return attempts === 1
                ? Effect.fail(
                    new InngestError({
                      cause: new Error("temporarily offline"),
                    })
                  )
                : Effect.void;
            }),
        });

        const first = yield* resumeWaitByToken({
          token: RESUME_TOKEN,
          body: {},
        }).pipe(Effect.provide(seams.layer), Effect.exit);
        const second = yield* resumeWaitByToken({
          token: RESUME_TOKEN,
          body: {},
        }).pipe(Effect.provide(seams.layer), Effect.exit);

        assert.strictEqual(first._tag, "Failure");
        assert.strictEqual(second._tag, "Success");
        assert.strictEqual(attempts, 2);
      })
    );
  });
});
