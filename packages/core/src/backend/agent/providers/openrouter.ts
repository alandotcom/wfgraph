/**
 * OpenRouter's Chat Completions API as the build agent's model, through
 * `wfOpenRouter`.
 */

import {
  OpenRouterClient,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
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
  type AgentReasoningEffort,
  agentPromptCacheKey,
  MAX_AGENT_OUTPUT_TOKENS,
  present,
  redacted,
  requiredModel,
} from "#src/backend/agent/model";

/** The options `wfOpenRouter` takes. */
export type OpenRouterAgentOptions = AgentTurnLimitOptions & {
  /**
   * Optional in the type so a host can pass `process.env.OPENROUTER_API_KEY`
   * straight through; a blank one turns the agent off rather than failing the
   * app's start.
   */
  readonly apiKey: string | undefined;
  /** Required: an OpenRouter model id such as `anthropic/claude-opus-5-5`. */
  readonly model: string;
  /**
   * Sent as OpenRouter's `reasoning.effort` only when set, because the routed
   * model may take none.
   */
  readonly reasoningEffort?: AgentReasoningEffort | undefined;
  /** Replaces `https://openrouter.ai/api/v1`. */
  readonly baseUrl?: string | undefined;
};

/**
 * Runs the build agent on OpenRouter. Pass what it returns as `agent`. A blank
 * `apiKey` leaves the agent off; a blank `model` or a `maxConcurrentTurns`
 * that is not a positive integer throws.
 */
export function wfOpenRouter(
  options: OpenRouterAgentOptions
): WfGraphAgentModel {
  const maxConcurrentTurns = readMaxConcurrentTurns(
    options.maxConcurrentTurns,
    "wfOpenRouter's maxConcurrentTurns"
  );
  const apiKey = present(options.apiKey);
  if (apiKey === undefined) {
    return AGENT_OFF;
  }
  const model = requiredModel("wfOpenRouter", options.model);
  const effort = options.reasoningEffort;
  const apiUrl = present(options.baseUrl);

  return agentModel({
    enabled: true,
    provider: "openrouter",
    model,
    maxConcurrentTurns,
    modelLayer: (turn) =>
      OpenRouterLanguageModel.model(
        model,
        omitUndefined({
          max_tokens: MAX_AGENT_OUTPUT_TOKENS,
          prompt_cache_key: agentPromptCacheKey(turn.workflowId),
          reasoning: effort === undefined ? undefined : { effort },
        })
      ).pipe(
        Layer.provide(
          OpenRouterClient.layer(
            omitUndefined({ apiKey: redacted(apiKey), apiUrl })
          )
        ),
        Layer.provide(FetchHttpClient.layer)
      ),
  });
}
