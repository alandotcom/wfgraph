// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports; reaching it through the
// `@effect/vitest` re-export leaves it unable to find the module registry.
import { vi } from "vitest";
import { Effect } from "effect";
import { Inngest } from "inngest";
import {
  InngestClient,
  InngestError,
  makeInngestClientLayer,
} from "#src/backend/lib/effect/inngest-client";

/**
 * The three envelope builders the live Layer delegates to, replaced so a send
 * never reaches a dev server.
 *
 * What the Layer adds over them is the error channel, and that is the whole of
 * what these tests are about: a rejected promise becomes an `InngestError`
 * keeping whatever was thrown, and a resolution travels through untouched.
 * vitest scopes a mock to the file that declares it.
 */
const runtimeEvents = vi.hoisted(() => ({
  sendWorkflowRunRequested: vi.fn(),
  sendWorkflowCancelRequested: vi.fn(),
  sendWorkflowWaitSignal: vi.fn(),
}));

vi.mock("#src/backend/lib/inngest/runtime-events", () => runtimeEvents);

// A real client, because constructing one opens nothing: the mocked envelope
// builders take it as their first argument and none of them calls it.
const testClient = new Inngest({ id: "inngest-client-test", isDev: true });
const TestInngestClientLayer = makeInngestClientLayer(testClient);

const runRequest = {
  graph: { nodes: [], edges: [] },
  executionId: "exec_1",
  workflowId: "wf_1",
};

const cancelRequest = {
  executionId: "exec_1",
  workflowId: "wf_1",
  reason: "Replaced by webhook event order.updated",
  requestedBy: "webhook",
};

const waitSignal = {
  executionId: "exec_1",
  nodeId: "node_wait",
  token: "resume_token_1",
  signalType: "wait-resume" as const,
};

describe("TestInngestClientLayer", () => {
  layer(TestInngestClientLayer)((it) => {
    it.effect("hands back the event id an accepted run answered with", () =>
      Effect.gen(function* () {
        runtimeEvents.sendWorkflowRunRequested.mockResolvedValue({
          eventId: "evt_1",
        });

        const inngest = yield* InngestClient;
        const sent = yield* inngest.sendRunRequested(runRequest);

        assert.deepStrictEqual(sent, { eventId: "evt_1" });
      })
    );

    it.effect("keeps what a refused run threw", () =>
      Effect.gen(function* () {
        const thrown = new Error("inngest dev server unreachable");
        runtimeEvents.sendWorkflowRunRequested.mockRejectedValue(thrown);

        const inngest = yield* InngestClient;
        const failure = yield* inngest
          .sendRunRequested(runRequest)
          .pipe(Effect.flip);

        assert.instanceOf(failure, InngestError);
        assert.strictEqual(failure.cause, thrown);
      })
    );

    it.effect("keeps what a refused cancel threw", () =>
      Effect.gen(function* () {
        const thrown = new Error("cancel rejected");
        runtimeEvents.sendWorkflowCancelRequested.mockRejectedValue(thrown);

        const inngest = yield* InngestClient;
        const failure = yield* inngest
          .sendCancelRequested(cancelRequest)
          .pipe(Effect.flip);

        assert.instanceOf(failure, InngestError);
        assert.strictEqual(failure.cause, thrown);
      })
    );

    it.effect("keeps what a refused wait signal threw", () =>
      Effect.gen(function* () {
        const thrown = new Error("wait signal rejected");
        runtimeEvents.sendWorkflowWaitSignal.mockRejectedValue(thrown);

        const inngest = yield* InngestClient;
        const failure = yield* inngest
          .sendWaitSignal(waitSignal)
          .pipe(Effect.flip);

        assert.instanceOf(failure, InngestError);
        assert.strictEqual(failure.cause, thrown);
      })
    );

    // The two void sends discard what the SDK answered, so what an accepted one
    // proves is only that it reached the builder and came back succeeding.
    it.effect("passes an accepted cancel and wait signal through", () =>
      Effect.gen(function* () {
        runtimeEvents.sendWorkflowCancelRequested.mockResolvedValue({
          ids: ["evt_2"],
        });
        runtimeEvents.sendWorkflowWaitSignal.mockResolvedValue({
          ids: ["evt_3"],
        });

        const inngest = yield* InngestClient;
        yield* inngest.sendCancelRequested(cancelRequest);
        yield* inngest.sendWaitSignal(waitSignal);

        // The client is the first argument of every send, which is what says
        // the Layer passes on the one it was built with.
        assert.deepStrictEqual(
          runtimeEvents.sendWorkflowCancelRequested.mock.lastCall,
          [testClient, cancelRequest]
        );
        assert.deepStrictEqual(
          runtimeEvents.sendWorkflowWaitSignal.mock.lastCall,
          [testClient, waitSignal]
        );
      })
    );
  });
});
