import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { collectAgentTurn } from "#src/agent/harness";

describe("collectAgentTurn", () => {
  it("interrupts stream collection and runs its finalizer after abort", async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finalized = false;
    const stream = Stream.fromEffect(
      Effect.sync(() => markStarted?.()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => (finalized = true)))
      )
    );

    const running = collectAgentTurn(Effect.succeed(stream), controller.signal);
    await started;
    controller.abort();

    await expect(running).rejects.toThrow();
    expect(finalized).toBe(true);
  });

  it("converts a stream failure to an error part", async () => {
    const parts = await collectAgentTurn(
      Effect.succeed(Stream.fail("stream failed")),
      undefined
    );

    expect(parts).toEqual([{ type: "error", message: "stream failed" }]);
  });
});
