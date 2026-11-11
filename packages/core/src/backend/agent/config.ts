/**
 * The host's agent configuration, and the service that carries it.
 *
 * The build agent is off until a host passes a key (or, for an
 * OpenAI-compatible server, a base URL), which is how an adopter who wants no
 * AI in their editor gets none: nothing is called, nothing is billed, and the
 * chat panel is absent.
 *
 * The key arrives as an option and travels by argument, never as module state,
 * so a second app in the same process cannot read the first one's credential.
 */

import { Context, Layer, Semaphore } from "effect";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import type { WfGraphAgentRunner } from "#src/backend/agent/runner";

/**
 * How many agent turns one application runtime streams at once when the host
 * names no `agent.maxConcurrentTurns`. A turn past the limit is refused with a
 * message asking the person to wait, rather than queued behind the others.
 */
export const DEFAULT_MAX_CONCURRENT_AGENT_TURNS = 4;

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
 *
 * Chosen by the eval suite in `packages/evals`, where it passed as many cases
 * as `gpt-6.1-sol` at half the price. `gpt-6-luna` costs a tenth as much and
 * passed fewer, so a host that prefers the lower bill names it in `model`.
 */
export const DEFAULT_AGENT_MODEL = "gpt-6.1-terra";

/**
 * How hard the model thinks before it answers, every value the GPT-6 models
 * take. Which of them one model accepts is the model's own rule: `gpt-6.1-sol`
 * and `gpt-6-astra` refuse `none`, and the provider answers a refused value
 * with a message naming the ones that model takes.
 *
 * Hand-mirrored from `OpenAiLanguageModel.Config`, because `config.ts` builds
 * no provider client and `agent/model.ts` is the one file that does. Nothing checks the
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
 * cannot change how the agent behaves.
 */
export const DEFAULT_AGENT_REASONING_EFFORT: AgentReasoningEffort = "medium";

/** The same `medium`, under the type Anthropic's effort takes. */
const DEFAULT_ANTHROPIC_REASONING_EFFORT: AnthropicReasoningEffort = "medium";

/** The providers the built-in agent can run on, each through Effect's own package. */
export const AGENT_PROVIDERS = [
  "openai",
  "anthropic",
  "openrouter",
  "openai-compatible",
] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/**
 * The efforts Anthropic's `output_config.effort` takes. Anthropic has no
 * `none`: a Claude model that thinks cannot be told not to, only how much.
 */
export type AnthropicReasoningEffort = Exclude<AgentReasoningEffort, "none">;

/**
 * OpenAI's Responses API, the default. `provider` may be left out.
 *
 * `baseUrl` replaces `https://api.openai.com/v1`, and the endpoint behind it
 * must implement `POST {baseUrl}/responses` with streaming, function tools and
 * reasoning items. A gateway offering Chat Completions alone takes
 * `"openai-compatible"` instead.
 */
export type WfGraphOpenAiAgentConfig = {
  readonly provider?: "openai" | undefined;
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
  readonly baseUrl?: string | undefined;
};

/**
 * Anthropic's Messages API. The turn runs with adaptive thinking, which a
 * Claude model from the 4.6 generation on accepts, and `reasoningEffort` sets
 * `output_config.effort`. `baseUrl` replaces `https://api.anthropic.com` and
 * must implement `POST {baseUrl}/v1/messages`.
 */
export type WfGraphAnthropicAgentConfig = {
  readonly provider: "anthropic";
  /** A blank key turns the agent off, as for OpenAI. */
  readonly apiKey: string | undefined;
  /**
   * Required: no eval in this repository has measured a Claude model against
   * the agent's tools, so there is no default to stand behind.
   */
  readonly model: string;
  /** Defaults to `DEFAULT_AGENT_REASONING_EFFORT`. */
  readonly reasoningEffort?: AnthropicReasoningEffort | undefined;
  readonly baseUrl?: string | undefined;
};

/**
 * OpenRouter's Chat Completions API. `reasoningEffort` is sent as OpenRouter's
 * `reasoning.effort` only when set, because the routed model may take none.
 * `baseUrl` replaces `https://openrouter.ai/api/v1`.
 */
export type WfGraphOpenRouterAgentConfig = {
  readonly provider: "openrouter";
  /** A blank key turns the agent off, as for OpenAI. */
  readonly apiKey: string | undefined;
  /** Required: an OpenRouter model id such as `anthropic/claude-opus-5-5`. */
  readonly model: string;
  readonly reasoningEffort?: AgentReasoningEffort | undefined;
  readonly baseUrl?: string | undefined;
};

/**
 * Any server implementing OpenAI's Chat Completions API: `POST
 * {baseUrl}/chat/completions` with `stream: true` and function tools. This is
 * the provider for vLLM, Ollama, LiteLLM and most gateways. `reasoningEffort`
 * is sent as the top-level `reasoning_effort` field only when set.
 */
export type WfGraphOpenAiCompatibleAgentConfig = {
  readonly provider: "openai-compatible";
  /**
   * Required, and what turns the agent on: a blank one leaves it off. A
   * conventional value ends in `/v1`.
   */
  readonly baseUrl: string | undefined;
  /** Sent as a bearer token when non-blank. A local server may need none. */
  readonly apiKey?: string | undefined;
  /** Required: the server's own model id. */
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
};

/** The `agent` option for a model the built-in agent runs against. */
export type WfGraphModelAgentConfig =
  | WfGraphOpenAiAgentConfig
  | WfGraphAnthropicAgentConfig
  | WfGraphOpenRouterAgentConfig
  | WfGraphOpenAiCompatibleAgentConfig;

/**
 * The `agent` option for a host that runs turns itself, on its own gateway or
 * model. The built-in model settings do not apply.
 */
export type WfGraphRunnerAgentConfig = {
  readonly runner: WfGraphAgentRunner;
};

/** What every form of the `agent` option takes beside its model or runner. */
export type WfGraphAgentCapacityConfig = {
  /**
   * How many turns this process streams at once, across every person using
   * the editor. A positive integer; defaults to
   * `DEFAULT_MAX_CONCURRENT_AGENT_TURNS`.
   */
  readonly maxConcurrentTurns?: number | undefined;
};

export type WfGraphAgentConfig = (
  | WfGraphModelAgentConfig
  | WfGraphRunnerAgentConfig
) &
  WfGraphAgentCapacityConfig;

/**
 * The model one turn runs against, by provider. `agent/model.ts` is the one
 * file that turns this into a provider client.
 */
export type AgentModelSettings =
  | {
      readonly provider: "openai";
      readonly apiKey: string;
      readonly model: string;
      readonly reasoningEffort: AgentReasoningEffort;
      readonly baseUrl?: string | undefined;
    }
  | {
      readonly provider: "anthropic";
      readonly apiKey: string;
      readonly model: string;
      readonly reasoningEffort: AnthropicReasoningEffort;
      readonly baseUrl?: string | undefined;
    }
  | {
      readonly provider: "openrouter";
      readonly apiKey: string;
      readonly model: string;
      readonly reasoningEffort?: AgentReasoningEffort | undefined;
      readonly baseUrl?: string | undefined;
    }
  | {
      readonly provider: "openai-compatible";
      readonly apiKey?: string | undefined;
      readonly model: string;
      readonly reasoningEffort?: string | undefined;
      readonly baseUrl: string;
    };

/** The configuration a turn actually runs against. */
export type EnabledAgentSettings = AgentModelSettings & {
  readonly enabled: true;
  readonly maxConcurrentTurns: number;
};

/** The configuration of a host's own runner. */
export type HostRunnerAgentSettings = {
  readonly enabled: true;
  readonly runner: WfGraphAgentRunner;
  readonly maxConcurrentTurns: number;
};

/** What a model config reads to: off, or one of the built-in providers. */
export type ModelAgentSettings =
  | { readonly enabled: false }
  | EnabledAgentSettings;

/** The configuration as the runtime holds it, absent when the agent is off. */
export type AgentSettings = ModelAgentSettings | HostRunnerAgentSettings;

export class AgentConfig extends Context.Service<AgentConfig, AgentSettings>()(
  "@wfgraph/core/AgentConfig"
) {}

/** Shared capacity for model-backed turns in one application runtime. */
export class AgentCapacity extends Context.Service<
  AgentCapacity,
  Semaphore.Semaphore
>()("@wfgraph/core/AgentCapacity") {}

const DISABLED = { enabled: false } as const;

/** The turn limit, refusing anything but a positive integer at startup. */
function readMaxConcurrentTurns(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_CONCURRENT_AGENT_TURNS;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("agent.maxConcurrentTurns must be a positive integer");
  }
  return value;
}

/** A trimmed value, or undefined for a blank or absent one. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** A model the provider has no default for, refusing a blank one at startup. */
function requiredModel(provider: AgentProvider, model: string): string {
  const named = present(model);
  if (!named) {
    throw new Error(
      `agent.model is required for the "${provider}" provider, which has no default model.`
    );
  }
  return named;
}

/**
 * Reads the host's option into the settings the runtime carries.
 *
 * A key of whitespace is the same as no key. Saying so here means the chat
 * route answers the same way for a missing variable and an empty one, which is
 * what a half-filled `.env` produces. A blank `model` for a provider with no
 * default throws, because that is a host's mistake rather than an absent key.
 */
export function readAgentSettings(
  config: (WfGraphModelAgentConfig & WfGraphAgentCapacityConfig) | undefined
): ModelAgentSettings;
export function readAgentSettings(
  config: WfGraphAgentConfig | undefined
): AgentSettings;
export function readAgentSettings(
  config: WfGraphAgentConfig | undefined
): AgentSettings {
  if (!config) {
    return DISABLED;
  }
  const maxConcurrentTurns = readMaxConcurrentTurns(config.maxConcurrentTurns);
  if ("runner" in config) {
    return { enabled: true, runner: config.runner, maxConcurrentTurns };
  }

  switch (config.provider) {
    case undefined:
    case "openai": {
      const apiKey = present(config.apiKey);
      if (!apiKey) {
        return DISABLED;
      }
      return omitUndefined({
        enabled: true as const,
        maxConcurrentTurns,
        provider: "openai" as const,
        apiKey,
        model: present(config.model) ?? DEFAULT_AGENT_MODEL,
        reasoningEffort:
          config.reasoningEffort ?? DEFAULT_AGENT_REASONING_EFFORT,
        baseUrl: present(config.baseUrl),
      });
    }

    case "anthropic": {
      const apiKey = present(config.apiKey);
      if (!apiKey) {
        return DISABLED;
      }
      return omitUndefined({
        enabled: true as const,
        maxConcurrentTurns,
        provider: "anthropic" as const,
        apiKey,
        model: requiredModel(config.provider, config.model),
        reasoningEffort:
          config.reasoningEffort ?? DEFAULT_ANTHROPIC_REASONING_EFFORT,
        baseUrl: present(config.baseUrl),
      });
    }

    case "openrouter": {
      const apiKey = present(config.apiKey);
      if (!apiKey) {
        return DISABLED;
      }
      return omitUndefined({
        enabled: true as const,
        maxConcurrentTurns,
        provider: "openrouter" as const,
        apiKey,
        model: requiredModel(config.provider, config.model),
        reasoningEffort: config.reasoningEffort,
        baseUrl: present(config.baseUrl),
      });
    }

    case "openai-compatible": {
      const baseUrl = present(config.baseUrl);
      if (!baseUrl) {
        return DISABLED;
      }
      return omitUndefined({
        enabled: true as const,
        maxConcurrentTurns,
        provider: "openai-compatible" as const,
        apiKey: present(config.apiKey),
        model: requiredModel(config.provider, config.model),
        reasoningEffort: present(config.reasoningEffort),
        baseUrl,
      });
    }

    default:
      return unknownProvider(config);
  }
}

/** A provider the type does not name, from a JavaScript host. */
function unknownProvider(_config: never): never {
  throw new Error(
    `agent.provider must be one of ${AGENT_PROVIDERS.join(", ")}.`
  );
}

export function makeAgentConfigLayer(
  settings: AgentSettings
): Layer.Layer<AgentConfig | AgentCapacity> {
  return Layer.merge(
    Layer.succeed(AgentConfig, settings),
    Layer.effect(
      AgentCapacity,
      Semaphore.make(
        settings.enabled
          ? settings.maxConcurrentTurns
          : DEFAULT_MAX_CONCURRENT_AGENT_TURNS
      )
    )
  );
}

/** What the chat route says when no key was configured. */
export function agentDisabledMessage(): string {
  return `The build agent is off because no model API key was configured. Pass agent.apiKey to createWfGraphApp, conventionally from ${API_KEY_ENV}, or agent.baseUrl for an "openai-compatible" server.`;
}
