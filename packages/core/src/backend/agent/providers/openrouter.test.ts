import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_MAX_CONCURRENT_AGENT_TURNS } from "#src/backend/agent/config";
import {
  agentPromptCacheKey,
  MAX_AGENT_OUTPUT_TOKENS,
} from "#src/backend/agent/model";
import { wfOpenRouter } from "#src/backend/agent/providers/openrouter";
import {
  chatCompletionsAnswer,
  INVALID_TURN_LIMITS,
  streamOnce,
} from "#src/backend/agent/providers/wire-test-support";

describe("wfOpenRouter", () => {
  it("leaves the agent off for a blank key", () => {
    expect(
      wfOpenRouter({ apiKey: " ", model: "anthropic/claude-opus-5-5" })
    ).toEqual({ enabled: false });
  });

  it("refuses a blank model, which OpenRouter has no default for", () => {
    expect(() => wfOpenRouter({ apiKey: "k", model: "" })).toThrow(
      'agent.model is required for the "openrouter" provider'
    );
  });

  it.effect("sends the model and reasoning effort it was given", () =>
    Effect.gen(function* () {
      const agent = wfOpenRouter({
        apiKey: "sk-or-test",
        model: "anthropic/claude-opus-5-5",
        reasoningEffort: "low",
      });
      expect(agent).toMatchObject({
        enabled: true,
        provider: "openrouter",
        model: "anthropic/claude-opus-5-5",
        maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
      });

      const { request, text } = yield* streamOnce(agent, chatCompletionsAnswer);

      expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe("Bearer sk-or-test");
      expect(request.body).toMatchObject({
        model: "anthropic/claude-opus-5-5",
        max_tokens: MAX_AGENT_OUTPUT_TOKENS,
        prompt_cache_key: agentPromptCacheKey("workflow-1"),
        reasoning: { effort: "low" },
      });
      expect(text).toBe("Ready");
    })
  );

  it.effect("sends no reasoning field when none was named", () =>
    Effect.gen(function* () {
      const { request } = yield* streamOnce(
        wfOpenRouter({ apiKey: "sk-or-test", model: "openai/gpt-6.1-terra" }),
        chatCompletionsAnswer
      );

      expect(request.body).not.toHaveProperty("reasoning");
    })
  );

  it("takes the host's turn limit and refuses one that is not a count", () => {
    const options = { apiKey: "sk-or-test", model: "openai/gpt-6.1-terra" };
    expect(wfOpenRouter({ ...options, maxConcurrentTurns: 16 })).toMatchObject({
      maxConcurrentTurns: 16,
    });
    for (const maxConcurrentTurns of INVALID_TURN_LIMITS) {
      expect(() => wfOpenRouter({ ...options, maxConcurrentTurns })).toThrow(
        "agent.maxConcurrentTurns must be a positive integer"
      );
    }
  });
});
