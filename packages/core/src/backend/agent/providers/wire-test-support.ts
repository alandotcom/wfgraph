/**
 * Runs one turn of a provider function's model against a `fetch` that records
 * the request and answers a stream in the shape the provider's documentation
 * gives. No key reaches a network: these are the shapes the provider packages
 * read, checked against what each provider module sends.
 */

import { Effect, Stream } from "effect";
import { LanguageModel } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import {
  type AgentModelSettings,
  agentModelSettings,
  type EnabledAgentSettings,
  type WfGraphAgentModel,
} from "#src/backend/agent/config";
import type { WfGraphAgentToolkit } from "#src/backend/agent/runner";

export type RecordedRequest = {
  readonly url: string;
  readonly headers: Headers;
  readonly body: JsonObject;
};

/** A server-sent event stream of `events`, ending in `[DONE]` when asked. */
export function sse(
  events: readonly unknown[],
  options?: { done?: boolean }
): Response {
  const lines = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (options?.done) {
    lines.push("data: [DONE]\n\n");
  }
  return new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** The settings a provider function's value carries, failing for any other value. */
export function settingsOf(agent: WfGraphAgentModel): AgentModelSettings {
  const settings = agentModelSettings(agent);
  if (settings === undefined) {
    throw new Error("Expected a value a provider function returned");
  }
  return settings;
}

/** The settings of a model a provider function turned on, failing otherwise. */
export function enabled(agent: WfGraphAgentModel): EnabledAgentSettings {
  const settings = settingsOf(agent);
  if (!settings.enabled) {
    throw new Error("Expected the provider function to turn the agent on");
  }
  return settings;
}

/** A fetch that records every request and answers each with `answer()`. */
export function recordingFetch(answer: () => Response): {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = readJsonObject(await new Response(init?.body ?? "{}").json());
    if (body === null) {
      throw new Error("The model sent a request body that is not an object");
    }
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body,
    });
    return answer();
  };
  return { fetch, requests };
}

/**
 * Streams one prompt through the model for workflow `workflow-1`, with
 * `toolkit` when one is given, and answers the first request it sent and the
 * text the stream carried.
 */
export function streamOnce(
  settings: EnabledAgentSettings,
  answer: () => Response,
  toolkit?: WfGraphAgentToolkit
): Effect.Effect<{ request: RecordedRequest; text: string }, unknown> {
  return Effect.gen(function* () {
    const { fetch, requests } = recordingFetch(answer);

    const parts = yield* LanguageModel.LanguageModel.pipe(
      Effect.flatMap((model) =>
        Stream.runCollect(
          toolkit === undefined
            ? model.streamText({ prompt: "Hello" })
            : model.streamText({ prompt: "Hello", toolkit })
        )
      ),
      Effect.provide(settings.modelLayer({ workflowId: "workflow-1" })),
      Effect.provideService(FetchHttpClient.Fetch, fetch)
    );

    const request = requests[0];
    if (request === undefined) {
      throw new Error("The model sent no request");
    }
    const text = Array.from(parts)
      .flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
      .join("");
    return { request, text };
  });
}

/** A Messages API stream answering "Ready", in the shape Anthropic documents. */
export const messagesAnswer = (): Response =>
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
  ]);

/** A Chat Completions stream answering "Ready", as OpenRouter and a compatible server send it. */
export const chatCompletionsAnswer = (): Response =>
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

/** The turn limits every provider function and the runner form refuse. */
export const INVALID_TURN_LIMITS = [0, -1, 1.5, Number.NaN] as const;
