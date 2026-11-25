/** OpenAI's Responses API as the build agent's model, through `wfOpenAi`. */

import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
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
} from "#src/backend/agent/model";

/**
 * The model used when the host names none.
 *
 * Verified against `GET /v1/models` rather than taken from a doc example, and
 * exercised against the real tool schemas: the agent's parameters are strict
 * function schemas, and which of them a model will accept is a fact about the
 * model, not about the schema.
 *
 * Chosen by the eval suite in `packages/evals`, where it passed as many cases
 * as `gpt-6.1-sol` at half the price. `gpt-6-luna` costs a tenth as much and
 * passes fewer: 213 of 234 runs over three passes of the 78-run suite, against
 * 152 of 156 for this model (Fisher's exact test, p = 0.011). Five of the
 * `gpt-6-luna` runs built a graph the request did not ask for, most often with
 * a Condition nobody requested. A host that prefers the lower bill names it
 * in `model`.
 */
export const DEFAULT_AGENT_MODEL = "gpt-6.1-terra";

/**
 * The effort a turn runs at when the host names none.
 *
 * `medium` because nothing measured says otherwise, and every step above it
 * bills an adopter latency and tokens. Twenty trials per arm gave the capability
 * suite 16 of 20 at `high` against 12 of 20 here, which Fisher's exact test
 * cannot separate from noise (p = 0.30), and the complex suite 21 of 21 against
 * 19 of 21 (p = 0.49). Neither arm's failures were ones more thinking would fix.
 * Separating an effect that size would take roughly a hundred trials per arm.
 *
 * It is named rather than left unset so a provider changing its own default
 * cannot change how the agent behaves.
 */
export const DEFAULT_AGENT_REASONING_EFFORT: AgentReasoningEffort = "medium";

/** The options `wfOpenAi` takes. */
export type OpenAiAgentOptions = AgentTurnLimitOptions & {
  /**
   * Optional in the type so a host can pass `process.env.OPENAI_API_KEY`
   * straight through; a blank one turns the agent off rather than failing the
   * app's start.
   */
  readonly apiKey: string | undefined;
  /** Defaults to `DEFAULT_AGENT_MODEL`. */
  readonly model?: string | undefined;
  /** Defaults to `DEFAULT_AGENT_REASONING_EFFORT`. */
  readonly reasoningEffort?: AgentReasoningEffort | undefined;
  /**
   * Replaces `https://api.openai.com/v1`. The endpoint behind it must
   * implement `POST {baseUrl}/responses` with streaming, function tools and
   * reasoning items. A gateway offering Chat Completions alone takes
   * `wfOpenAiCompatible` instead.
   */
  readonly baseUrl?: string | undefined;
};

/**
 * Runs the build agent on OpenAI's Responses API. Pass what it returns as
 * `agent`. A blank `apiKey` leaves the agent off; a `maxConcurrentTurns` that
 * is not a positive integer throws.
 */
export function wfOpenAi(options: OpenAiAgentOptions): WfGraphAgentModel {
  const maxConcurrentTurns = readMaxConcurrentTurns(
    options.maxConcurrentTurns,
    "wfOpenAi's maxConcurrentTurns"
  );
  const apiKey = present(options.apiKey);
  if (apiKey === undefined) {
    return AGENT_OFF;
  }
  const model = present(options.model) ?? DEFAULT_AGENT_MODEL;
  const effort = options.reasoningEffort ?? DEFAULT_AGENT_REASONING_EFFORT;
  const apiUrl = present(options.baseUrl);

  return agentModel({
    enabled: true,
    provider: "openai",
    model,
    maxConcurrentTurns,
    // The reasoning effort is pinned so a default that moves under us cannot
    // change how the agent behaves, and the summary is what the panel renders
    // as the agent's working-out: the provider bills the reasoning tokens
    // either way and streams nothing readable without it.
    modelLayer: (turn) =>
      OpenAiLanguageModel.model(model, {
        max_output_tokens: MAX_AGENT_OUTPUT_TOKENS,
        reasoning: { effort, summary: "auto" },
        // The Responses API stores every response unless told not to, and
        // nothing here reads one back: each step resends the conversation,
        // with reasoning carried as encrypted content, which Effect's client
        // asks for whenever `store` is not `true`.
        store: false,
        prompt_cache_key: agentPromptCacheKey(turn.workflowId),
      }).pipe(
        Layer.provide(
          OpenAiClient.layer(
            omitUndefined({ apiKey: redacted(apiKey), apiUrl })
          )
        ),
        Layer.provide(FetchHttpClient.layer)
      ),
  });
}
