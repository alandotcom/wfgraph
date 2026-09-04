import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "@wfgraph/core/backend/agent/runner";
import {
  collectAgentTurn,
  createWorkflowAgentHarness,
} from "#src/agent/harness";
import type { AgentEvalInput } from "#src/agent/types";

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

  it("runs an injected runner with the scenario tool session", async () => {
    let receivedMessage = "";
    let receivedDocument: unknown;
    const runner: AgentRunner = {
      metadata: { provider: "test", model: "custom-runner" },
      run: (input) => {
        receivedMessage = input.messages[0]?.content ?? "";
        return Effect.gen(function* () {
          receivedDocument = yield* input.session.draft.current;
          input.observeTrace({ type: "model-step-start", step: 1 });
          input.observeTrace({
            type: "model-step-finish",
            step: 1,
            reason: "stop",
            usage: { inputTokens: {}, outputTokens: {} },
          });
          return Stream.succeed({
            type: "text-delta" as const,
            id: "text-1",
            delta: "Done",
          });
        });
      },
    };
    const input: AgentEvalInput = {
      messages: [{ role: "user", content: "Build it" }],
      document: { nodes: [], edges: [] },
      catalog: { actions: [], events: [], integrations: [] },
      integrations: [],
      expected: {},
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [],
    };
    const artifacts: Record<string, never> = {};
    const harness = createWorkflowAgentHarness(() => runner);

    const result = await harness.run(input, {
      artifacts,
      setArtifact: (name, value) => {
        Object.assign(artifacts, { [name]: value });
      },
    });

    expect(receivedMessage).toBe("Build it");
    expect(receivedDocument).toEqual(input.document);
    expect(result.output?.finalText).toBe("Done");
    expect(result.usage).toMatchObject({
      provider: "test",
      model: "custom-runner",
    });
  });
});
