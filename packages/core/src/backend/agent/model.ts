/**
 * The language model one turn runs against.
 *
 * Built per request rather than held on the application runtime: the layer
 * closes over a credential, and an application runtime outlives every request.
 *
 * The AI runtime itself lives in `effect/ai`, so this file is only the
 * provider half, and it is the one file that names a provider package. Every
 * tool and the whole stream mapping speak `LanguageModel`, so a provider is a
 * case here and nowhere else.
 */

import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import {
  OpenAiClient as OpenAiCompatClient,
  OpenAiLanguageModel as OpenAiCompatLanguageModel,
} from "@effect/ai-openai-compat";
import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
import { Layer, Redacted } from "effect";
import type { LanguageModel } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import type { AgentModelSettings } from "#src/backend/agent/config";

/** Maximum provider output for one model call inside a turn. */
export const MAX_AGENT_OUTPUT_TOKENS = 8_192;

/** What a model layer needs to know about the turn it serves. */
export type AgentModelTurn = {
  readonly workflowId: string;
};

/**
 * The prompt cache key for one workflow's turns.
 *
 * Every turn and step on one workflow shares a prefix (the system prompt, the
 * tools and the conversation so far), and turns on different workflows share
 * only the first two. One key per workflow keeps a workflow's steps in one
 * cache bucket and keeps one workflow's cache hits from being probed through
 * another's.
 */
export function agentPromptCacheKey(workflowId: string): string {
  return `wfgraph-agent:${workflowId}`;
}

function redacted(apiKey: string | undefined) {
  return apiKey === undefined ? undefined : Redacted.make(apiKey);
}

/**
 * The model layer for this turn.
 *
 * Settings arrive by argument rather than out of the runtime, so the layer has
 * no branch for an agent that is off. Whoever holds enabled settings has already
 * asked that question.
 *
 * Every provider's reasoning control is pinned where the provider has one, so a
 * default that moves under us cannot change how the agent behaves without a
 * change here. The OpenAI and Anthropic cases also ask for a readable summary
 * of the reasoning, which is what the panel renders as the agent's working-out:
 * the provider bills the reasoning tokens either way and streams nothing
 * readable without it.
 */
export function agentModelLayer(
  settings: AgentModelSettings,
  turn: AgentModelTurn
): Layer.Layer<LanguageModel.LanguageModel> {
  const cacheKey = agentPromptCacheKey(turn.workflowId);
  switch (settings.provider) {
    case "openai":
      return OpenAiLanguageModel.model(settings.model, {
        max_output_tokens: MAX_AGENT_OUTPUT_TOKENS,
        reasoning: { effort: settings.reasoningEffort, summary: "auto" },
        // The Responses API stores every response unless told not to, and
        // nothing here reads one back: each step resends the conversation,
        // with reasoning carried as encrypted content, which Effect's client
        // asks for whenever `store` is not `true`.
        store: false,
        prompt_cache_key: cacheKey,
      }).pipe(
        Layer.provide(
          OpenAiClient.layer(
            omitUndefined({
              apiKey: redacted(settings.apiKey),
              apiUrl: settings.baseUrl,
            })
          )
        ),
        Layer.provide(FetchHttpClient.layer)
      );

    case "anthropic":
      return AnthropicLanguageModel.model(settings.model, {
        max_tokens: MAX_AGENT_OUTPUT_TOKENS,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: settings.reasoningEffort },
        // Anthropic takes at most 20 strict tools in one request and Effect's
        // client marks every tool strict by default. The toolkit holds more
        // than 20, so none is strict; each tool decodes its own arguments and
        // answers a refusal the model reads when they do not fit.
        strictJsonSchema: false,
        // Automatic caching: Anthropic places the breakpoint on the last
        // cacheable block, so each step of a turn reads the conversation the
        // step before it wrote.
        cache_control: { type: "ephemeral" },
      }).pipe(
        Layer.provide(
          AnthropicClient.layer(
            omitUndefined({
              apiKey: redacted(settings.apiKey),
              apiUrl: settings.baseUrl,
            })
          )
        ),
        Layer.provide(FetchHttpClient.layer)
      );

    case "openrouter":
      return OpenRouterLanguageModel.model(
        settings.model,
        omitUndefined({
          max_tokens: MAX_AGENT_OUTPUT_TOKENS,
          prompt_cache_key: cacheKey,
          reasoning:
            settings.reasoningEffort === undefined
              ? undefined
              : { effort: settings.reasoningEffort },
        })
      ).pipe(
        Layer.provide(
          OpenRouterClient.layer(
            omitUndefined({
              apiKey: redacted(settings.apiKey),
              apiUrl: settings.baseUrl,
            })
          )
        ),
        Layer.provide(FetchHttpClient.layer)
      );

    case "openai-compatible":
      // The compat package takes the Responses API's field names and writes
      // the Chat Completions request from them: `max_output_tokens` is sent as
      // `max_tokens`, and a field it does not know, `reasoning_effort` here,
      // is passed through as written.
      return OpenAiCompatLanguageModel.model(
        settings.model,
        omitUndefined({
          max_output_tokens: MAX_AGENT_OUTPUT_TOKENS,
          reasoning_effort: settings.reasoningEffort,
        })
      ).pipe(
        Layer.provide(
          OpenAiCompatClient.layer(
            omitUndefined({
              apiKey: redacted(settings.apiKey),
              apiUrl: settings.baseUrl,
            })
          )
        ),
        Layer.provide(FetchHttpClient.layer)
      );

    default:
      return unknownProvider(settings);
  }
}

function unknownProvider(_settings: never): never {
  throw new Error("No model layer exists for this agent provider.");
}
