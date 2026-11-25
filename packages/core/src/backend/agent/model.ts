/**
 * What every model provider module under `agent/providers/` shares: the output
 * token limit, the prompt cache key, the reasoning efforts, and the rules for
 * reading a provider function's options.
 */

import { Redacted } from "effect";

/** Maximum provider output for one model call inside a turn. */
export const MAX_AGENT_OUTPUT_TOKENS = 8_192;

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

/** The API key as a `Redacted` value a provider client takes, or undefined. */
export function redacted(
  apiKey: string | undefined
): Redacted.Redacted | undefined {
  return apiKey === undefined ? undefined : Redacted.make(apiKey);
}

/**
 * How hard the model thinks before it answers, every value the GPT-6 models
 * take. Which of them one model accepts is the model's own rule: `gpt-6.1-sol`
 * and `gpt-6-astra` refuse `none`, and the provider answers a refused value
 * with a message naming the ones that model takes.
 *
 * Hand-mirrored from `OpenAiLanguageModel.Config`, because this module imports
 * no provider package. Nothing checks the two against each other: the client
 * sends the request body unencoded, so a value this union carries and the
 * provider has dropped fails at the API rather than at the build. Re-read the
 * provider's Config when it bumps.
 *
 * One declaration rather than a type beside a list, so the runtime set cannot
 * fall behind the type. `packages/evals` validates an environment override
 * against it.
 */
export const AGENT_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];

/**
 * A trimmed value, or undefined for a blank or absent one.
 *
 * A key of whitespace is the same as no key. Saying so here means the chat
 * route answers the same way for a missing variable and an empty one, which is
 * what a half-filled `.env` produces.
 */
export function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A model the provider has no default for, refusing a blank one, because that
 * is a host's mistake rather than an absent key. `caller` names the provider
 * function the host called, such as `wfAnthropic`.
 */
export function requiredModel(caller: string, model: string): string {
  const named = present(model);
  if (!named) {
    throw new Error(
      `${caller} needs a non-blank model, because its provider has no default model.`
    );
  }
  return named;
}
