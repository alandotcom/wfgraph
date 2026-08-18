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

import { Context, Layer } from "effect";

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

export type WfGraphAgentConfig = {
  /**
   * The OpenAI API key. Optional in the type so a host can pass
   * `process.env.OPENAI_API_KEY` straight through; a blank one turns the agent
   * off rather than failing the app's start.
   */
  readonly apiKey: string | undefined;
  /** Defaults to `DEFAULT_AGENT_MODEL`. */
  readonly model?: string;
  /** For an OpenAI-compatible endpoint that is not OpenAI's own. */
  readonly baseUrl?: string;
};

/** The configuration a turn actually runs against. */
export type EnabledAgentSettings = {
  readonly enabled: true;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
};

/** The configuration as the runtime holds it, absent when the agent is off. */
export type AgentSettings = { readonly enabled: false } | EnabledAgentSettings;

export class AgentConfig extends Context.Service<AgentConfig, AgentSettings>()(
  "@wfgraph/core/AgentConfig"
) {}

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
    ...(config?.baseUrl ? { baseUrl: config.baseUrl } : {}),
  };
}

export function makeAgentConfigLayer(
  settings: AgentSettings
): Layer.Layer<AgentConfig> {
  return Layer.succeed(AgentConfig, settings);
}

/** What the chat route says when no key was configured. */
export function agentDisabledMessage(): string {
  return `The build agent is off because no model API key was configured. Pass agent.apiKey to createWfGraphApp, conventionally from ${API_KEY_ENV}.`;
}
