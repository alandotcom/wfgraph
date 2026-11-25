/**
 * Any server implementing OpenAI's Chat Completions API as the build agent's
 * model, through `wfOpenAiCompatible`.
 */

import {
  OpenAiClient as OpenAiCompatClient,
  OpenAiLanguageModel as OpenAiCompatLanguageModel,
} from "@effect/ai-openai-compat";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  AGENT_OFF,
  agentModel,
  type AgentTurnLimitOptions,
  readMaxConcurrentTurns,
  type WfGraphAgentModel,
} from "#src/backend/agent/config";
import {
  MAX_AGENT_OUTPUT_TOKENS,
  present,
  redacted,
  requiredModel,
} from "#src/backend/agent/model";

/** The options `wfOpenAiCompatible` takes. */
export type OpenAiCompatibleAgentOptions = AgentTurnLimitOptions & {
  /**
   * Required, and what turns the agent on: a blank one leaves it off. A
   * conventional value ends in `/v1`. The server must implement
   * `POST {baseUrl}/chat/completions` with `stream: true` and function tools.
   */
  readonly baseUrl: string | undefined;
  /** Sent as a bearer token when non-blank. A local server may need none. */
  readonly apiKey?: string | undefined;
  /** Required: the server's own model id. */
  readonly model: string;
  /** Sent as the top-level `reasoning_effort` field only when set. */
  readonly reasoningEffort?: string | undefined;
};

/**
 * Runs the build agent on a server implementing OpenAI's Chat Completions
 * API, such as vLLM, Ollama, LiteLLM and most gateways. Pass what it returns
 * as `agent`. A blank `baseUrl` leaves the agent off; a blank `model` or a
 * `maxConcurrentTurns` that is not a positive integer throws.
 */
export function wfOpenAiCompatible(
  options: OpenAiCompatibleAgentOptions
): WfGraphAgentModel {
  const maxConcurrentTurns = readMaxConcurrentTurns(
    options.maxConcurrentTurns,
    "wfOpenAiCompatible's maxConcurrentTurns"
  );
  const apiUrl = present(options.baseUrl);
  if (apiUrl === undefined) {
    return AGENT_OFF;
  }
  const model = requiredModel("wfOpenAiCompatible", options.model);
  const apiKey = present(options.apiKey);
  const effort = present(options.reasoningEffort);

  return agentModel({
    enabled: true,
    provider: "openai-compatible",
    model,
    maxConcurrentTurns,
    // The compat package takes the Responses API's field names and writes the
    // Chat Completions request from them: `max_output_tokens` is sent as
    // `max_tokens`, and a field it does not know, `reasoning_effort` here, is
    // passed through as written.
    modelLayer: () =>
      OpenAiCompatLanguageModel.model(
        model,
        omitUndefined({
          max_output_tokens: MAX_AGENT_OUTPUT_TOKENS,
          reasoning_effort: effort,
        })
      ).pipe(
        Layer.provide(
          OpenAiCompatClient.layer(
            omitUndefined({ apiKey: redacted(apiKey), apiUrl })
          )
        ),
        Layer.provide(FetchHttpClient.layer)
      ),
  });
}
