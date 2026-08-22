import { Cause, Effect, Semaphore, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { AgentStreamPart } from "@wfgraph/shared/rpc/agent-stream";
import {
  limitAgentStream,
  observeAgentStream,
} from "#src/backend/services/agent/chat";

const reply: AgentStreamPart = {
  type: "text-delta",
  id: "text-1",
  delta: "Ready",
};

describe("observeAgentStream", () => {
  it.effect("records a running failure before returning it to the client", () =>
    Effect.gen(function* () {
      const failures: unknown[] = [];
      const parts = yield* Stream.runCollect(
        observeAgentStream(Stream.fail(new Error("provider failed")), (cause) =>
          Effect.sync(() => failures.push(cause))
        )
      );

      expect(failures).toHaveLength(1);
      expect(parts).toEqual([{ type: "error", message: "provider failed" }]);
    })
  );

  it.effect("lets request cancellation end the stream quietly", () =>
    Effect.gen(function* () {
      const failures: unknown[] = [];
      const parts = yield* Stream.runCollect(
        observeAgentStream(Stream.failCause(Cause.interrupt()), (cause) =>
          Effect.sync(() => failures.push(cause))
        )
      );

      expect(failures).toEqual([]);
      expect(parts).toEqual([]);
    })
  );
});

describe("limitAgentStream", () => {
  it.effect("refuses a turn when every agent permit is occupied", () =>
    Effect.gen(function* () {
      const capacity = yield* Semaphore.make(1);
      yield* capacity.take(1);

      const parts = yield* Stream.runCollect(
        limitAgentStream(Stream.succeed(reply), capacity)
      );

      expect(parts).toEqual([
        {
          type: "error",
          message:
            "The build agent is busy with other turns. Wait for one to finish and try again.",
        },
      ]);
      yield* capacity.release(1);
    })
  );

  it.effect("returns its permit when the stream finishes", () =>
    Effect.gen(function* () {
      const capacity = yield* Semaphore.make(1);
      const parts = yield* Stream.runCollect(
        limitAgentStream(Stream.succeed(reply), capacity)
      );

      expect(parts).toEqual([reply]);
      expect(yield* capacity.takeIfAvailable(1)).toBe(true);
      yield* capacity.release(1);
    })
  );
});
