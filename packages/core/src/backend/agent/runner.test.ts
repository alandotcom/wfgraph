import { Deferred, Effect, Fiber, Semaphore, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { AgentStreamPart } from "@wfgraph/shared/rpc/agent-stream";
import { makeAgentToolSession } from "#src/backend/agent/tool-session";
import { runAgentRunner, type AgentRunner } from "#src/backend/agent/runner";
import { limitAgentStream } from "#src/backend/services/agent/chat";
import { observeAgentStream } from "#src/backend/services/agent/chat";

const reply: AgentStreamPart = {
  type: "text-delta",
  id: "text-1",
  delta: "Ready",
};

const makeSession = () =>
  makeAgentToolSession({
    document: { nodes: [], edges: [] },
    catalog: { actions: [], events: [], integrations: [] },
    integrations: [],
    validateDraft: () => ({
      draftValid: true,
      structuralIssues: [],
      publishBlockers: [],
      warnings: [],
    }),
  });

describe("runAgentRunner", () => {
  it.effect("passes the turn through an injected runner unchanged", () =>
    Effect.gen(function* () {
      const session = yield* makeSession();
      let receivedSession: typeof session | undefined;
      const runner: AgentRunner = {
        metadata: { provider: "test", model: "test-runner" },
        run: (input) => {
          receivedSession = input.session;
          return Effect.succeed(Stream.succeed(reply));
        },
      };

      const parts = yield* Stream.runCollect(
        runAgentRunner(runner, {
          messages: [{ role: "user", content: "Build it" }],
          session,
          observeTrace: () => undefined,
        })
      );

      expect(parts).toEqual([reply]);
      expect(receivedSession).toBe(session);
    })
  );

  it.effect("propagates a runner construction failure", () =>
    Effect.gen(function* () {
      const session = yield* makeSession();
      const runner: AgentRunner = {
        metadata: { provider: "test", model: "test-runner" },
        run: () => Effect.fail("runner failed"),
      };

      const exit = yield* Effect.exit(
        Stream.runDrain(
          runAgentRunner(runner, {
            messages: [],
            session,
            observeTrace: () => undefined,
          })
        )
      );

      expect(exit).toEqual(
        expect.objectContaining({
          _tag: "Failure",
        })
      );
    })
  );

  it.effect(
    "aborts the runner and releases capacity when collection stops",
    () =>
      Effect.gen(function* () {
        const session = yield* makeSession();
        const started = yield* Deferred.make<AbortSignal>();
        const capacity = yield* Semaphore.make(1);
        const runner: AgentRunner = {
          metadata: { provider: "test", model: "test-runner" },
          run: (input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, input.signal);
              return Stream.never;
            }),
        };
        const fiber = yield* Effect.forkChild(
          Stream.runDrain(
            limitAgentStream(
              observeAgentStream(
                runAgentRunner(runner, {
                  messages: [],
                  session,
                  observeTrace: () => undefined,
                }),
                () => Effect.void
              ),
              capacity
            )
          )
        );

        const signal = yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);

        expect(signal.aborted).toBe(true);
        expect(yield* capacity.takeIfAvailable(1)).toBe(true);
        yield* capacity.release(1);
      })
  );
});
