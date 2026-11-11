import { Effect, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { LanguageModel } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import type { AgentModelSettings } from "#src/backend/agent/config";
import {
  agentModelLayer,
  agentPromptCacheKey,
  MAX_AGENT_OUTPUT_TOKENS,
} from "#src/backend/agent/model";

/**
 * Each provider is exercised over the wire format it speaks, with `fetch`
 * replaced by one that records the request and answers a stream in the shape
 * the provider's documentation gives. No key reaches a network: these are the
 * shapes the provider packages read, checked against what this file sends.
 */
type RecordedRequest = {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
};

function sse(events: readonly unknown[], options?: { done?: boolean }) {
  const lines = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (options?.done) {
    lines.push("data: [DONE]\n\n");
  }
  return new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function streamOnce(
  settings: AgentModelSettings,
  answer: () => Response
): Effect.Effect<
  { request: RecordedRequest | undefined; text: string },
  unknown
> {
  return Effect.gen(function* () {
    const requests: RecordedRequest[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const bodyText = await new Response(init?.body ?? "{}").text();
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(bodyText) as Record<string, unknown>,
      });
      return answer();
    };

    const parts = yield* LanguageModel.LanguageModel.pipe(
      Effect.flatMap((model) =>
        Stream.runCollect(model.streamText({ prompt: "Hello" }))
      ),
      Effect.provide(agentModelLayer(settings, { workflowId: "workflow-1" })),
      Effect.provideService(FetchHttpClient.Fetch, fetch)
    );

    const request = requests[0];
    expect(request).toBeDefined();
    const text = Array.from(parts)
      .flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
      .join("");
    return { request, text };
  });
}

const chatCompletionsAnswer = () =>
  sse(
    [
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Ready" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: "test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    ],
    { done: true }
  );

describe("agentModelLayer", () => {
  it.effect(
    "keeps an OpenAI response unstored and caches it under the workflow",
    () =>
      Effect.gen(function* () {
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
        const { request, text } = yield* streamOnce(
          {
            provider: "openai",
            apiKey: "sk-test",
            model: "gpt-6.1-terra",
            reasoningEffort: "medium",
          },
          () =>
            sse([
              { type: "response.created", response },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: message,
              },
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
            ])
        );

        expect(request?.url).toBe("https://api.openai.com/v1/responses");
        expect(request?.body).toMatchObject({
          model: "gpt-6.1-terra",
          store: false,
          prompt_cache_key: agentPromptCacheKey("workflow-1"),
          max_output_tokens: MAX_AGENT_OUTPUT_TOKENS,
          reasoning: { effort: "medium", summary: "auto" },
        });
        expect(text).toBe("Ready");
      })
  );

  it.effect(
    "sends Anthropic adaptive thinking, a pinned effort and the key header",
    () =>
      Effect.gen(function* () {
        const { request, text } = yield* streamOnce(
          {
            provider: "anthropic",
            apiKey: "sk-ant-test",
            model: "claude-opus-5-5",
            reasoningEffort: "high",
          },
          () =>
            sse([
              {
                type: "message_start",
                message: {
                  id: "msg_1",
                  type: "message",
                  role: "assistant",
                  model: "claude-opus-5-5",
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 5, output_tokens: 0 },
                },
              },
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "Ready" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
              },
              { type: "message_stop" },
            ])
        );

        expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
        expect(request?.headers.get("x-api-key")).toBe("sk-ant-test");
        expect(request?.body).toMatchObject({
          model: "claude-opus-5-5",
          max_tokens: MAX_AGENT_OUTPUT_TOKENS,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: "high" },
          cache_control: { type: "ephemeral" },
        });
        expect(text).toBe("Ready");
      })
  );

  it.effect(
    "sends OpenRouter the model and reasoning effort it was given",
    () =>
      Effect.gen(function* () {
        const { request, text } = yield* streamOnce(
          {
            provider: "openrouter",
            apiKey: "sk-or-test",
            model: "anthropic/claude-opus-5-5",
            reasoningEffort: "low",
          },
          chatCompletionsAnswer
        );

        expect(request?.url).toBe(
          "https://openrouter.ai/api/v1/chat/completions"
        );
        expect(request?.headers.get("authorization")).toBe("Bearer sk-or-test");
        expect(request?.body).toMatchObject({
          model: "anthropic/claude-opus-5-5",
          max_tokens: MAX_AGENT_OUTPUT_TOKENS,
          reasoning: { effort: "low" },
        });
        expect(text).toBe("Ready");
      })
  );

  it.effect("sends OpenRouter no reasoning field when none was named", () =>
    Effect.gen(function* () {
      const { request } = yield* streamOnce(
        {
          provider: "openrouter",
          apiKey: "sk-or-test",
          model: "openai/gpt-6.1-terra",
        },
        chatCompletionsAnswer
      );

      expect(request?.body).not.toHaveProperty("reasoning");
    })
  );

  it.effect(
    "sends an OpenAI-compatible server Chat Completions with its own base URL",
    () =>
      Effect.gen(function* () {
        const { request, text } = yield* streamOnce(
          {
            provider: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
            model: "qwen3",
            reasoningEffort: "medium",
          },
          chatCompletionsAnswer
        );

        expect(request?.url).toBe("http://localhost:11434/v1/chat/completions");
        // No key was configured, so none is sent.
        expect(request?.headers.get("authorization")).toBeNull();
        expect(request?.body).toMatchObject({
          model: "qwen3",
          max_tokens: MAX_AGENT_OUTPUT_TOKENS,
          reasoning_effort: "medium",
          stream: true,
        });
        expect(text).toBe("Ready");
      })
  );
});
