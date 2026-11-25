/** Anthropic's Messages API as the build agent's model, through `wfAnthropic`. */

import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
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
  MAX_AGENT_OUTPUT_TOKENS,
  present,
  redacted,
  requiredModel,
} from "#src/backend/agent/model";

/**
 * The efforts Anthropic's `output_config.effort` takes. Anthropic has no
 * `none`: a Claude model that thinks cannot be told not to, only how much.
 */
type AnthropicReasoningEffort = Exclude<AgentReasoningEffort, "none">;

/**
 * The effort an Anthropic turn runs at when the host names none.
 *
 * `high`, which is also Anthropic's own default for the model measured. On
 * the 78-run eval suite `claude-sonnet-5-5` built the right graph in every
 * run at `medium` and at `high`, and at `medium` it skipped the steps the
 * authoring rules ask for around the edit far more often: 30 runs failed on
 * those rules alone against 12 at `high` (Fisher's exact test, p = 0.002).
 * The mean turn took 12.9 seconds at `high` against 11.8.
 */
const DEFAULT_ANTHROPIC_REASONING_EFFORT: AnthropicReasoningEffort = "high";

/** The options `wfAnthropic` takes. */
export type AnthropicAgentOptions = AgentTurnLimitOptions & {
  /**
   * Optional in the type so a host can pass `process.env.ANTHROPIC_API_KEY`
   * straight through; a blank one turns the agent off rather than failing the
   * app's start.
   */
  readonly apiKey: string | undefined;
  /**
   * Required: a host chooses its Claude model. `claude-sonnet-5-5` is the one
   * this repository's eval suite has measured against the agent's tools.
   */
  readonly model: string;
  /** Sets `output_config.effort`. Defaults to `high`. */
  readonly reasoningEffort?: AnthropicReasoningEffort | undefined;
  /**
   * Replaces `https://api.anthropic.com`, and must implement
   * `POST {baseUrl}/v1/messages`.
   */
  readonly baseUrl?: string | undefined;
};

/**
 * Runs the build agent on Anthropic's Messages API, with adaptive thinking,
 * which a Claude model from the 4.6 generation on accepts. Pass what it
 * returns as `agent`. A blank `apiKey` leaves the agent off; a blank `model`
 * or a `maxConcurrentTurns` that is not a positive integer throws.
 */
export function wfAnthropic(options: AnthropicAgentOptions): WfGraphAgentModel {
  const maxConcurrentTurns = readMaxConcurrentTurns(
    options.maxConcurrentTurns,
    "wfAnthropic's maxConcurrentTurns"
  );
  const apiKey = present(options.apiKey);
  if (apiKey === undefined) {
    return AGENT_OFF;
  }
  const model = requiredModel("wfAnthropic", options.model);
  const effort = options.reasoningEffort ?? DEFAULT_ANTHROPIC_REASONING_EFFORT;
  const apiUrl = present(options.baseUrl);

  return agentModel({
    enabled: true,
    provider: "anthropic",
    model,
    maxConcurrentTurns,
    // The effort is pinned so a default that moves under us cannot change how
    // the agent behaves, and the summarized thinking is what the panel renders
    // as the agent's working-out.
    modelLayer: () =>
      AnthropicLanguageModel.model(model, {
        max_tokens: MAX_AGENT_OUTPUT_TOKENS,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort },
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
            omitUndefined({ apiKey: redacted(apiKey), apiUrl })
          )
        ),
        Layer.provide(FetchHttpClient.layer)
      ),
  });
}
