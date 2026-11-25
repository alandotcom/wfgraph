/**
 * The host's `agent` option, and the service that carries it.
 *
 * The option is either what a provider entry's function returns (`wfOpenAi`,
 * `wfAnthropic`, `wfOpenRouter` or `wfOpenAiCompatible`), or a host's own
 * runner. This module imports no provider package: each provider's client is
 * built by the function in that provider's own entry, and core runs a turn
 * through the `modelLayer` function the returned value carries.
 *
 * The key arrives as an option and travels by argument, never as module state,
 * so a second app in the same process cannot read the first one's credential.
 */

import { Context, Layer, Semaphore } from "effect";
import type { LanguageModel } from "effect/ai";
import type { WfGraphAgentRunner } from "#src/backend/agent/runner";

/**
 * How many agent turns one application runtime streams at once when the host
 * names no `maxConcurrentTurns`. A turn past the limit is refused with a
 * message asking the person to wait, rather than queued behind the others.
 */
export const DEFAULT_MAX_CONCURRENT_AGENT_TURNS = 4;

/** What a model layer needs to know about the turn it serves. */
export type AgentModelTurn = {
  readonly workflowId: string;
};

/** A built-in provider's settings once its key or base URL turned it on. */
export type EnabledAgentSettings = {
  readonly enabled: true;
  /** The provider's name, such as `anthropic`, for logs and spans. */
  readonly provider: string;
  /** The model id every turn runs against, for logs and spans. */
  readonly model: string;
  readonly maxConcurrentTurns: number;
  /**
   * Builds the provider's `LanguageModel` for one turn. Called once per
   * request, because the layer closes over the credential and an application
   * runtime outlives every request.
   */
  readonly modelLayer: (
    turn: AgentModelTurn
  ) => Layer.Layer<LanguageModel.LanguageModel>;
};

/**
 * A model the built-in agent runs against, as a provider entry's function
 * returns it, which a host passes as `agent`. It reads `{ enabled: false }`
 * when the function was given a blank key, or for `wfOpenAiCompatible` a
 * blank base URL, which leaves the agent off.
 */
export type WfGraphAgentModel =
  | { readonly enabled: false }
  | EnabledAgentSettings;

/**
 * The `agent` option for a host that runs turns itself, on its own gateway or
 * model. The built-in model settings do not apply.
 */
export type WfGraphRunnerAgentConfig = {
  readonly runner: WfGraphAgentRunner;
  /**
   * How many turns this process streams at once, across every person using
   * the editor. A positive integer; defaults to
   * `DEFAULT_MAX_CONCURRENT_AGENT_TURNS`.
   */
  readonly maxConcurrentTurns?: number | undefined;
};

/** The `agent` option of `createWfGraphApp` and of a `wfWorker` request. */
export type WfGraphAgentConfig = WfGraphAgentModel | WfGraphRunnerAgentConfig;

/** The configuration of a host's own runner. */
export type HostRunnerAgentSettings = {
  readonly enabled: true;
  readonly runner: WfGraphAgentRunner;
  readonly maxConcurrentTurns: number;
};

/** The configuration as the runtime holds it. */
export type AgentSettings = WfGraphAgentModel | HostRunnerAgentSettings;

export class AgentConfig extends Context.Service<AgentConfig, AgentSettings>()(
  "@wfgraph/core/AgentConfig"
) {}

/** Shared capacity for model-backed turns in one application runtime. */
export class AgentCapacity extends Context.Service<
  AgentCapacity,
  Semaphore.Semaphore
>()("@wfgraph/core/AgentCapacity") {}

/** What a provider function returns for a blank key: the agent is off. */
export const AGENT_OFF: WfGraphAgentModel = { enabled: false };

/**
 * The turn limit, refusing anything but a positive integer at startup. Every
 * provider function and the runner form read `maxConcurrentTurns` through it,
 * before anything else, so a bad limit fails even when the key is blank.
 */
export function readMaxConcurrentTurns(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_CONCURRENT_AGENT_TURNS;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("agent.maxConcurrentTurns must be a positive integer");
  }
  return value;
}

/**
 * Reads the host's option into the settings the runtime carries.
 *
 * A provider function already resolved its own defaults, so its value is
 * carried as it is. The runner form's turn limit is checked here.
 */
export function readAgentSettings(
  config: WfGraphAgentConfig | undefined
): AgentSettings {
  if (config === undefined) {
    return AGENT_OFF;
  }
  if ("runner" in config) {
    return {
      enabled: true,
      runner: config.runner,
      maxConcurrentTurns: readMaxConcurrentTurns(config.maxConcurrentTurns),
    };
  }
  if (!("enabled" in config)) {
    return unknownAgentOption(config);
  }
  return config;
}

/**
 * An `agent` value that is neither a provider function's result nor a runner,
 * from a JavaScript host. A plain object naming a key and a model throws here
 * at startup.
 */
function unknownAgentOption(_config: never): never {
  throw new Error(
    "agent takes what a provider function returns, such as wfOpenAi from @wfgraph/core/openai, or { runner }."
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

/** What the chat route says when the agent is off. */
export function agentDisabledMessage(): string {
  return "The build agent is off because no model API key was configured. Pass a provider function such as wfOpenAi from @wfgraph/core/openai as agent to createWfGraphApp, with a non-blank apiKey, or wfOpenAiCompatible with a non-blank baseUrl.";
}
