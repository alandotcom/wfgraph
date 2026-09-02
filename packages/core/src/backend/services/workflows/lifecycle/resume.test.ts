// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { hash } from "bcryptjs";
import { Effect, Layer } from "effect";
import { NotFound, Unauthorized } from "#src/backend/lib/effect/failures";
import {
  InngestError,
  type InngestClient,
} from "#src/backend/lib/effect/inngest-client";
import {
  SilentAppLoggerLayer,
  stubApiKeyRepo,
  stubExecutionRepo,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import type { ApiKeyCandidate } from "#src/backend/services/api-keys/repo";
import type {
  ExecutionRepo,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import {
  postWorkflowResume,
  resumeWaitByToken,
} from "#src/backend/services/workflows/lifecycle/resume";

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

/**
 * The keys one test stored, the wait it can find, and a record of whether the
 * token was ever looked up.
 *
 * The order of the two checks is the point: a wait token travels in a URL and so
 * accumulates in browser history, proxy logs
 * and referrers, and answering "not found" rather than "unauthorized" to a
 * caller holding one but no API key tells them whether that token is still live.
 * `tokenLookups` stays empty for every rejected key, which is what pins it.
 */
function makeResumeSeams(input: {
  candidates: ApiKeyCandidate[];
  waitState?: WorkflowWaitState | undefined;
  sendWaitSignal?: InngestClient["Service"]["sendWaitSignal"] | undefined;
}) {
  const calls = {
    tokenLookups: [] as string[],
    claimed: false,
    auditEvents: [] as Parameters<
      ExecutionRepo["Service"]["recordAuditEvent"]
    >[0][],
  };

  return {
    layer: Layer.mergeAll(
      stubApiKeyRepo({
        findByPrefix: () => Effect.succeed(input.candidates),
        touchLastUsed: () => Effect.void,
      }),
      stubExecutionRepo({
        claimWaitingStateByToken: (hookToken) =>
          Effect.sync(() => {
            calls.tokenLookups.push(hookToken);
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
        settleWaitingStateClaim: () => Effect.succeed(true),
        markRunning: () => Effect.succeed(true),
        recordAuditEvent: (event) =>
          Effect.sync(() => {
            calls.auditEvents.push(event);
          }),
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

describe("postWorkflowResume", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("refuses a request carrying no Authorization header", () =>
      Effect.gen(function* () {
        const seams = makeResumeSeams({ candidates: [] });

        const failure = yield* postWorkflowResume({
          token: RESUME_TOKEN,
          body: {},
          authHeader: null,
        }).pipe(Effect.provide(seams.layer), Effect.flip);

        assert.instanceOf(failure, Unauthorized);
        assert.strictEqual(failure.error, "Missing Authorization header");
        assert.deepStrictEqual(seams.calls.tokenLookups, []);
      })
    );

    it.effect("refuses a well-formed key that matches nothing stored", () =>
      Effect.gen(function* () {
        const seams = makeResumeSeams({
          candidates: [
            {
              id: "k1",
              keyHash: yield* Effect.promise(() => hash("wfb_stored_key", 10)),
            },
          ],
          waitState: liveWaitState,
        });

        const failure = yield* postWorkflowResume({
          token: RESUME_TOKEN,
          body: {},
          authHeader: "Bearer wfb_not_the_stored_key",
        }).pipe(Effect.provide(seams.layer), Effect.flip);

        assert.instanceOf(failure, Unauthorized);
        assert.strictEqual(failure.error, "Invalid API key");
        assert.deepStrictEqual(seams.calls.tokenLookups, []);
      })
    );

    it.effect("reports a dead token only once the key checks out", () =>
      Effect.gen(function* () {
        const key = "wfb_valid_key";
        const seams = makeResumeSeams({
          candidates: [
            { id: "k1", keyHash: yield* Effect.promise(() => hash(key, 10)) },
          ],
        });

        const failure = yield* postWorkflowResume({
          token: RESUME_TOKEN,
          body: {},
          authHeader: `Bearer ${key}`,
        }).pipe(Effect.provide(seams.layer), Effect.flip);

        assert.instanceOf(failure, NotFound);
        assert.strictEqual(failure.error, "Wait not found or no longer active");
        assert.deepStrictEqual(seams.calls.tokenLookups, [RESUME_TOKEN]);
      })
    );

    it.effect("wakes the waiting node and marks the wait resumed", () =>
      Effect.gen(function* () {
        const key = "wfb_valid_key";
        const signals: Array<
          Parameters<InngestClient["Service"]["sendWaitSignal"]>[0]
        > = [];
        const seams = makeResumeSeams({
          candidates: [
            { id: "k1", keyHash: yield* Effect.promise(() => hash(key, 10)) },
          ],
          waitState: liveWaitState,
          sendWaitSignal: (signal) =>
            Effect.sync(() => {
              signals.push(signal);
            }),
        });

        const resumed = yield* postWorkflowResume({
          token: RESUME_TOKEN,
          body: { approved: true },
          authHeader: `Bearer ${key}`,
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
        assert.deepStrictEqual(seams.calls.auditEvents, [
          {
            workflowId: "wf_1",
            executionId: "exec_1",
            eventType: "run_resumed",
            message: "Run resumed from the resume endpoint",
            metadata: { waitStateId: "wait_1" },
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
          candidates: [],
          waitState: liveWaitState,
          sendWaitSignal: (signal) =>
            Effect.sync(() => {
              signals.push(signal);
            }),
        });

        const attempts = yield* Effect.all(
          [
            resumeWaitByToken({ token: RESUME_TOKEN, body: {}, source: "one" }),
            resumeWaitByToken({ token: RESUME_TOKEN, body: {}, source: "two" }),
          ].map(Effect.exit),
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

    it.effect("allows a retry when the wake signal is refused", () =>
      Effect.gen(function* () {
        let attempts = 0;
        const seams = makeResumeSeams({
          candidates: [],
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
          source: "first",
        }).pipe(Effect.provide(seams.layer), Effect.exit);
        const second = yield* resumeWaitByToken({
          token: RESUME_TOKEN,
          body: {},
          source: "retry",
        }).pipe(Effect.provide(seams.layer), Effect.exit);

        assert.strictEqual(first._tag, "Failure");
        assert.strictEqual(second._tag, "Success");
        assert.strictEqual(attempts, 2);
      })
    );
  });
});
