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
  enabled,
  settingsOf,
  streamOnce,
} from "#src/backend/agent/providers/wire-test-support";

describe("wfOpenRouter", () => {
  it("leaves the agent off for a blank key", () => {
    expect(
      settingsOf(
        wfOpenRouter({ apiKey: " ", model: "anthropic/claude-opus-5-5" })
      )
    ).toEqual({ enabled: false });
  });

  it("refuses a blank model, which OpenRouter has no default for", () => {
    expect(() => wfOpenRouter({ apiKey: "k", model: "" })).toThrow(
      "wfOpenRouter needs a non-blank model"
    );
  });

  it.effect("sends the model and reasoning effort it was given", () =>
    Effect.gen(function* () {
      const settings = enabled(
        wfOpenRouter({
          apiKey: "sk-or-test",
          model: "anthropic/claude-opus-5-5",
          reasoningEffort: "low",
        })
      );
      expect(settings).toMatchObject({
        provider: "openrouter",
        model: "anthropic/claude-opus-5-5",
        maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
      });

      const { request, text } = yield* streamOnce(
        settings,
        chatCompletionsAnswer
      );

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
        enabled(
          wfOpenRouter({ apiKey: "sk-or-test", model: "openai/gpt-6.1-terra" })
        ),
        chatCompletionsAnswer
      );

      expect(request.body).not.toHaveProperty("reasoning");
    })
  );
});
