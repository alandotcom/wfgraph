// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { vi } from "vitest";
import { hash } from "bcryptjs";
import { Effect, Layer } from "effect";
import { NotFound, Unauthorized } from "#src/backend/lib/effect/failures";
import type { InngestClient } from "#src/backend/lib/effect/inngest-client";
import {
  SilentAppLoggerLayer,
  stubApiKeyRepo,
  stubExecutionRepo,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import type { ApiKeyCandidate } from "#src/backend/services/api-keys/repo";
import type { WorkflowWaitState } from "#src/backend/services/workflows/executions/repo";
import { postWorkflowResume } from "#src/backend/services/workflows/triggering/resume";

/**
 * Waking a wait means a send plus the bookkeeping around it, and the
 * bookkeeping still runs through modules holding their own database handle.
 * Those two writes are replaced here so the assertions can read them; vitest
 * scopes a mock to the file that declares it.
 */
const waitStateWrites = vi.hoisted(() => ({
  markWaitStateStatus: vi.fn(
    (_input: { waitStateId: string; status: string }) => Promise.resolve(true)
  ),
  markExecutionRunning: vi.fn((_executionId: string) =>
    Promise.resolve(undefined)
  ),
}));

vi.mock("#src/backend/lib/workflow-wait-state", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("#src/backend/lib/workflow-wait-state")
  >()),
  ...waitStateWrites,
}));

vi.mock("#src/backend/lib/workflow-audit", () => ({
  logWorkflowAuditEvent: () => Promise.resolve(undefined),
}));

const HOOK_TOKEN = "hook_token_1";

const liveWaitState: WorkflowWaitState = {
  id: "wait_1",
  executionId: "exec_1",
  workflowId: "wf_1",
  runId: "run_1",
  nodeId: "node_wait",
  nodeName: "Wait for approval",
  waitType: "hook",
  status: "waiting",
  hookToken: HOOK_TOKEN,
  waitUntil: null,
  correlationKey: null,
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
 * The order of the two checks is the point, as it is on the intake route: a
 * wait token travels in a URL and so accumulates in browser history, proxy logs
 * and referrers, and answering "not found" rather than "unauthorized" to a
 * caller holding one but no API key tells them whether that token is still live.
 * `tokenLookups` stays empty for every rejected key, which is what pins it.
 */
function makeResumeSeams(input: {
  candidates: ApiKeyCandidate[];
  waitState?: WorkflowWaitState;
  sendWaitSignal?: InngestClient["Service"]["sendWaitSignal"];
}) {
  const calls = {
    tokenLookups: [] as string[],
  };

  return {
    layer: Layer.mergeAll(
      stubApiKeyRepo({
        findByPrefix: () => Effect.succeed(input.candidates),
        touchLastUsed: () => Effect.void,
      }),
      stubExecutionRepo({
        findWaitingStateByToken: (hookToken) =>
          Effect.sync(() => {
            calls.tokenLookups.push(hookToken);
            return input.waitState ?? null;
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
          token: HOOK_TOKEN,
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
          token: HOOK_TOKEN,
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
          token: HOOK_TOKEN,
          body: {},
          authHeader: `Bearer ${key}`,
        }).pipe(Effect.provide(seams.layer), Effect.flip);

        assert.instanceOf(failure, NotFound);
        assert.strictEqual(
          failure.error,
          "Wait hook not found or no longer active"
        );
        assert.deepStrictEqual(seams.calls.tokenLookups, [HOOK_TOKEN]);
      })
    );

    it.effect("wakes the waiting node and marks the wait resumed", () =>
      Effect.gen(function* () {
        waitStateWrites.markWaitStateStatus.mockClear();
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
          token: HOOK_TOKEN,
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
            token: HOOK_TOKEN,
            payload: { approved: true },
          },
        ]);
        assert.deepStrictEqual(waitStateWrites.markWaitStateStatus.mock.calls, [
          [{ waitStateId: "wait_1", status: "resumed" }],
        ]);
      })
    );
  });
});
