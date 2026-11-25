import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_MAX_CONCURRENT_AGENT_TURNS } from "#src/backend/agent/config";
import {
  agentPromptCacheKey,
  MAX_AGENT_OUTPUT_TOKENS,
} from "#src/backend/agent/model";
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_REASONING_EFFORT,
  wfOpenAi,
} from "#src/backend/agent/providers/openai";
import {
  enabled,
  settingsOf,
  sse,
  streamOnce,
} from "#src/backend/agent/providers/wire-test-support";

/** A Responses API stream answering "Ready", in the shape OpenAI documents. */
function responsesAnswer(): Response {
  const response = {
    id: "resp_1",
    object: "response",
    model: "gpt-6.1-terra",
    created_at: 1_700_000_000,
    output: [],
  };
  const message = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "in_progress",
    content: [],
  };
  return sse([
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: message },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "Ready",
    },
    {
      type: "response.completed",
      response: {
        ...response,
        usage: {
          input_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 6,
        },
      },
    },
  ]);
}

describe("wfOpenAi", () => {
  it("reads a half-filled environment as off rather than as broken", () => {
    // `process.env.OPENAI_API_KEY` on a machine with the line present but empty.
    expect(settingsOf(wfOpenAi({ apiKey: "" }))).toEqual({ enabled: false });
    expect(settingsOf(wfOpenAi({ apiKey: "   " }))).toEqual({ enabled: false });
    expect(settingsOf(wfOpenAi({ apiKey: undefined }))).toEqual({
      enabled: false,
    });
  });

  it.effect(
    "runs the default model at the default effort, unstored and cached under the workflow",
    () =>
      Effect.gen(function* () {
        const settings = enabled(wfOpenAi({ apiKey: "sk-test" }));
        expect(settings).toMatchObject({
          provider: "openai",
          model: DEFAULT_AGENT_MODEL,
          maxConcurrentTurns: DEFAULT_MAX_CONCURRENT_AGENT_TURNS,
        });

        const { request, text } = yield* streamOnce(settings, responsesAnswer);

        expect(request.url).toBe("https://api.openai.com/v1/responses");
        expect(request.headers.get("authorization")).toBe("Bearer sk-test");
        expect(request.body).toMatchObject({
          model: DEFAULT_AGENT_MODEL,
          store: false,
          prompt_cache_key: agentPromptCacheKey("workflow-1"),
          max_output_tokens: MAX_AGENT_OUTPUT_TOKENS,
          reasoning: {
            effort: DEFAULT_AGENT_REASONING_EFFORT,
            summary: "auto",
          },
        });
        expect(text).toBe("Ready");
      })
  );

  it.effect("takes the host's reasoning effort when it names one", () =>
    Effect.gen(function* () {
      const { request } = yield* streamOnce(
        enabled(wfOpenAi({ apiKey: "sk-test", reasoningEffort: "low" })),
        responsesAnswer
      );

      expect(request.body).toMatchObject({
        reasoning: { effort: "low", summary: "auto" },
      });
    })
  );

  it.effect("takes the host's model and endpoint, trimmed", () =>
    Effect.gen(function* () {
      const settings = enabled(
        wfOpenAi({
          apiKey: "  sk-test  ",
          model: " gpt-4.1 ",
          baseUrl: "https://gateway.example.test/v1",
        })
      );
      expect(settings).toMatchObject({ model: "gpt-4.1" });

      const { request } = yield* streamOnce(settings, responsesAnswer);

      expect(request.url).toBe("https://gateway.example.test/v1/responses");
      expect(request.headers.get("authorization")).toBe("Bearer sk-test");
      expect(request.body).toMatchObject({ model: "gpt-4.1" });
    })
  );

  it.effect("calls OpenAI's own endpoint for a blank baseUrl", () =>
    Effect.gen(function* () {
      const { request } = yield* streamOnce(
        enabled(wfOpenAi({ apiKey: "sk-test", baseUrl: "" })),
        responsesAnswer
      );

      expect(request.url).toBe("https://api.openai.com/v1/responses");
    })
  );
});
