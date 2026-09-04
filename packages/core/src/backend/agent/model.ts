/**
 * The language model one turn runs against.
 *
 * Built per request rather than held on the application runtime: the layer
 * closes over a credential, and an application runtime outlives every request.
 *
 * The AI runtime itself lives in `effect/unstable/ai`, so this file is only the
 * provider half. Swapping providers is a change here and nowhere else, because
 * every tool and the whole stream mapping speak `LanguageModel`.
 */

import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Layer, Redacted } from "effect";
import type { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import type { EnabledAgentSettings } from "#src/backend/agent/config";

/** Maximum provider output for one model call inside a turn. */
export const MAX_AGENT_OUTPUT_TOKENS = 8_192;

/**
 * The model layer for this turn.
 *
 * Settings arrive by argument rather than out of the runtime, so the layer has
 * no branch for an agent that is off. Whoever holds enabled settings has already
 * asked that question.
 */
export function agentModelLayer(
  settings: EnabledAgentSettings
): Layer.Layer<LanguageModel.LanguageModel> {
  const client = OpenAiClient.layer({
    apiKey: Redacted.make(settings.apiKey),
    apiUrl: settings.baseUrl,
  }).pipe(Layer.provide(FetchHttpClient.layer));

  return OpenAiLanguageModel.model(settings.model, {
    max_output_tokens: MAX_AGENT_OUTPUT_TOKENS,
    reasoning: { effort: settings.reasoningEffort },
  }).pipe(Layer.provide(client));
}
