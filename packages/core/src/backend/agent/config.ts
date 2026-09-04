/**
 * The host's agent configuration, and the service that carries it.
 *
 * The build agent is off until a host passes a key, which is how an adopter who
 * wants no AI in their editor gets none: nothing is called, nothing is billed,
 * and the chat panel is absent.
 *
 * The key arrives as an option and travels by argument, never as module state,
 * so a second app in the same process cannot read the first one's credential.
 */

import { Context, Layer, Semaphore } from "effect";

export const MAX_CONCURRENT_AGENT_TURNS = 4;

/**
 * The environment variable a host conventionally reads this from. Named only in
 * the message a misconfigured app fails with; nothing here reads the environment.
 */
const API_KEY_ENV = "OPENAI_API_KEY";

/**
 * The model used when the host names none.
 *
 * Verified against `GET /v1/models` rather than taken from a doc example, and
 * exercised against the real tool schemas: the agent's parameters are strict
 * function schemas, and which of them a model will accept is a fact about the
 * model, not about the schema.
 */
export const DEFAULT_AGENT_MODEL = "gpt-5.6-luna";

/**
 * How hard the model thinks before it answers, every value the provider takes.
 *
 * Hand-mirrored from `OpenAiLanguageModel.Config`, because `config.ts` names no
 * provider and `agent/model.ts` is the one file that does. Nothing checks the
 * two against each other: the client sends the request body unencoded, so a
 * value this union carries and the provider has dropped fails at the API rather
 * than at the build. Re-read the provider's Config when it bumps.
 *
 * One declaration rather than a type beside a list, so the runtime set cannot
 * fall behind the type. `packages/evals` validates an environment override
 * against it.
 */
export const AGENT_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];

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
 * cannot change how the agent behaves. `medium` is what `gpt-5.6` defaults to
 * today, so this pins current behaviour rather than altering it.
 */
export const DEFAULT_AGENT_REASONING_EFFORT: AgentReasoningEffort = "medium";

export type WfGraphAgentConfig = {
  /**
   * The OpenAI API key. Optional in the type so a host can pass
   * `process.env.OPENAI_API_KEY` straight through; a blank one turns the agent
   * off rather than failing the app's start.
   */
  readonly apiKey: string | undefined;
  /** Defaults to `DEFAULT_AGENT_MODEL`. */
  readonly model?: string | undefined;
  /** Defaults to `DEFAULT_AGENT_REASONING_EFFORT`. */
  readonly reasoningEffort?: AgentReasoningEffort | undefined;
  /** For an OpenAI-compatible endpoint that is not OpenAI's own. */
  readonly baseUrl?: string | undefined;
};

/** The configuration a turn actually runs against. */
export type EnabledAgentSettings = {
  readonly enabled: true;
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort: AgentReasoningEffort;
  readonly baseUrl?: string | undefined;
};

/** The configuration as the runtime holds it, absent when the agent is off. */
export type AgentSettings = { readonly enabled: false } | EnabledAgentSettings;

export class AgentConfig extends Context.Service<AgentConfig, AgentSettings>()(
  "@wfgraph/core/AgentConfig"
) {}

/** Shared capacity for model-backed turns in one application runtime. */
export class AgentCapacity extends Context.Service<
  AgentCapacity,
  Semaphore.Semaphore
>()("@wfgraph/core/AgentCapacity") {}

/**
 * Reads the host's option into the settings the runtime carries.
 *
 * A key of whitespace is the same as no key. Saying so here means the chat
 * route answers the same way for a missing variable and an empty one, which is
 * what a half-filled `.env` produces.
 */
export function readAgentSettings(
  config: WfGraphAgentConfig | undefined
): AgentSettings {
  const apiKey = config?.apiKey?.trim();
  if (!apiKey) {
    return { enabled: false };
  }

  return {
    enabled: true,
    apiKey,
    model: config?.model?.trim() || DEFAULT_AGENT_MODEL,
    reasoningEffort: config?.reasoningEffort ?? DEFAULT_AGENT_REASONING_EFFORT,
    // oxlint-disable-next-line wfgraph/no-conditional-spread -- an empty `baseUrl` counts as none, so the key is left off for both.
    ...(config?.baseUrl ? { baseUrl: config.baseUrl } : {}),
  };
}

export function makeAgentConfigLayer(
  settings: AgentSettings
): Layer.Layer<AgentConfig | AgentCapacity> {
  return Layer.merge(
    Layer.succeed(AgentConfig, settings),
    Layer.effect(AgentCapacity, Semaphore.make(MAX_CONCURRENT_AGENT_TURNS))
  );
}

/** What the chat route says when no key was configured. */
export function agentDisabledMessage(): string {
  return `The build agent is off because no model API key was configured. Pass agent.apiKey to createWfGraphApp, conventionally from ${API_KEY_ENV}.`;
}
