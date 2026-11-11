import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "@wfgraph/core/backend/agent/runner";
import {
  collectAgentTurn,
  createWorkflowAgentHarness,
  evalProviderKeyIsSet,
  readEvalModelSettings,
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
      catalog: { actions: [], entities: [], events: [], integrations: [] },
      integrations: [],
      expected: {},
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [],
    };
    const artifacts: string[] = [];
    const harness = createWorkflowAgentHarness(() => runner);

    const result = await harness.run(input, {
      signal: undefined,
      setArtifact: (name) => {
        artifacts.push(name);
      },
    });

    expect(receivedMessage).toBe("Build it");
    expect(receivedDocument).toEqual(input.document);
    expect(result.output.finalText).toBe("Done");
    expect(artifacts).toEqual(["finalDocument", "streamParts", "agentTrace"]);
    expect(result.usage).toMatchObject({
      provider: "test",
      model: "custom-runner",
    });
  });
});

describe("readEvalModelSettings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("measures OpenAI on its default model when no provider is named", () => {
    vi.stubEnv("WFGRAPH_EVAL_AGENT_PROVIDER", "");
    vi.stubEnv("WFGRAPH_EVAL_AGENT_MODEL", "");
    vi.stubEnv("WFGRAPH_EVAL_REASONING_EFFORT", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");

    expect(readEvalModelSettings()).toMatchObject({
      provider: "openai",
      apiKey: "sk-test",
      reasoningEffort: "medium",
    });
  });

  it("measures Anthropic with its own key and the model the run names", () => {
    vi.stubEnv("WFGRAPH_EVAL_AGENT_PROVIDER", "anthropic");
    vi.stubEnv("WFGRAPH_EVAL_AGENT_MODEL", "claude-sonnet-5-5");
    vi.stubEnv("WFGRAPH_EVAL_REASONING_EFFORT", "low");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

    expect(evalProviderKeyIsSet()).toBe(true);
    expect(readEvalModelSettings()).toMatchObject({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5-5",
      reasoningEffort: "low",
    });
  });

  it("skips a provider whose key is unset, whatever other key is set", () => {
    vi.stubEnv("WFGRAPH_EVAL_AGENT_PROVIDER", "anthropic");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    expect(evalProviderKeyIsSet()).toBe(false);
  });

  it("refuses a provider with no default model when the run names none", () => {
    vi.stubEnv("WFGRAPH_EVAL_AGENT_PROVIDER", "anthropic");
    vi.stubEnv("WFGRAPH_EVAL_AGENT_MODEL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

    expect(() => readEvalModelSettings()).toThrow("WFGRAPH_EVAL_AGENT_MODEL");
  });

  it("refuses a provider it does not know", () => {
    vi.stubEnv("WFGRAPH_EVAL_AGENT_PROVIDER", "gemini");

    expect(() => readEvalModelSettings()).toThrow(
      "Use one of openai, anthropic, openrouter"
    );
  });
});
