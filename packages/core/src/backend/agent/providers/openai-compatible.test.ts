import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_MAX_CONCURRENT_AGENT_TURNS } from "#src/backend/agent/config";
import { MAX_AGENT_OUTPUT_TOKENS } from "#src/backend/agent/model";
import { wfOpenAiCompatible } from "#src/backend/agent/providers/openai-compatible";
import {
  chatCompletionsAnswer,
  enabled,
  settingsOf,
  streamOnce,
} from "#src/backend/agent/providers/wire-test-support";

describe("wfOpenAiCompatible", () => {
  it("leaves the agent off for a blank base URL, even with a key", () => {
    expect(
      settingsOf(
        wfOpenAiCompatible({ baseUrl: " ", apiKey: "key", model: "qwen3" })
      )
    ).toEqual({ enabled: false });
    expect(
      settingsOf(wfOpenAiCompatible({ baseUrl: undefined, model: "qwen3" }))
    ).toEqual({ enabled: false });
  });

  it("refuses a blank model, which a compatible server has no default for", () => {
    expect(() =>
      wfOpenAiCompatible({ baseUrl: "http://localhost:11434/v1", model: "" })
    ).toThrow("wfOpenAiCompatible needs a non-blank model");
  });

  it.effect(
    "turns on by its base URL and sends Chat Completions there, with no key",
    () =>
      Effect.gen(function* () {
        const settings = enabled(
          wfOpenAiCompatible({
            baseUrl: " http://localhost:11434/v1 ",
            model: "qwen3",
            reasoningEffort: "medium",
          })
        );
        expect(settings).toMatchObject({
          provider: "openai-compatible",
          model: "qwen3",
          maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
        });

        const { request, text } = yield* streamOnce(
          settings,
          chatCompletionsAnswer
        );

        expect(request.url).toBe("http://localhost:11434/v1/chat/completions");
        // No key was configured, so none is sent.
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.body).toMatchObject({
          model: "qwen3",
          max_tokens: MAX_AGENT_OUTPUT_TOKENS,
          reasoning_effort: "medium",
          stream: true,
        });
        expect(text).toBe("Ready");
      })
  );

  it.effect("sends a key as a bearer token and no blank reasoning effort", () =>
    Effect.gen(function* () {
      const { request } = yield* streamOnce(
        enabled(
          wfOpenAiCompatible({
            baseUrl: "http://localhost:11434/v1",
            apiKey: " local-key ",
            model: "qwen3",
            reasoningEffort: " ",
          })
        ),
        chatCompletionsAnswer
      );

      expect(request.headers.get("authorization")).toBe("Bearer local-key");
      expect(request.body).not.toHaveProperty("reasoning_effort");
    })
  );
});
