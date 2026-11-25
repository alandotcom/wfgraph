/**
 * The host's `agent` option and the services that carry it. A provider entry's
 * function builds its value with `agentModel`, and `readAgentSettings` reads
 * that value or the `{ runner }` form once per runtime. A provider's key
 * travels inside its `modelLayer` function, never as module state.
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

/** The option every provider function and the `{ runner }` form take. */
export type AgentTurnLimitOptions = {
  /**
   * How many turns this process streams at once, across every person using
   * the editor. A positive integer; defaults to
   * `DEFAULT_MAX_CONCURRENT_AGENT_TURNS`.
   */
  readonly maxConcurrentTurns?: number | undefined;
};

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
 * A provider function's settings. `{ enabled: false }` is what it returns for
 * a blank key, or for `wfOpenAiCompatible` a blank base URL.
 */
export type AgentModelSettings =
  | { readonly enabled: false }
  | EnabledAgentSettings;

/** The brand that marks the value a provider function returns. */
const AGENT_MODEL: unique symbol = Symbol.for("@wfgraph/core/agent-model");

/**
 * What a provider entry's function returns, such as `wfOpenAi` from
 * `@wfgraph/core/openai`, which a host passes as `agent`.
 */
export type WfGraphAgentModel = { readonly [AGENT_MODEL]: unknown };

/**
 * The `agent` option for a host that runs turns itself, on its own gateway or
 * model. The built-in model settings do not apply.
 */
export type WfGraphRunnerAgentConfig = AgentTurnLimitOptions & {
  readonly runner: WfGraphAgentRunner;
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
export type AgentSettings = AgentModelSettings | HostRunnerAgentSettings;

export class AgentConfig extends Context.Service<AgentConfig, AgentSettings>()(
  "@wfgraph/core/AgentConfig"
) {}

/** Shared capacity for model-backed turns in one application runtime. */
export class AgentCapacity extends Context.Service<
  AgentCapacity,
  Semaphore.Semaphore
>()("@wfgraph/core/AgentCapacity") {}

/** The value a provider function returns, carrying `settings` under its brand. */
export function agentModel(settings: AgentModelSettings): WfGraphAgentModel {
  return { [AGENT_MODEL]: settings };
}

/** What a provider function returns for a blank key: the agent is off. */
export const AGENT_OFF: WfGraphAgentModel = agentModel({ enabled: false });

/**
 * The settings a provider function's value carries, or undefined for any
 * value a provider function did not build.
 */
export function agentModelSettings(
  value: unknown
): AgentModelSettings | undefined {
  return isAgentModel(value) ? value[AGENT_MODEL] : undefined;
}

function isAgentModel(
  value: unknown
): value is { readonly [AGENT_MODEL]: AgentModelSettings } {
  return typeof value === "object" && value !== null && AGENT_MODEL in value;
}

/**
 * The turn limit, refusing anything but a positive integer. `option` names
 * the option as the host wrote it, such as `wfAnthropic's maxConcurrentTurns`.
 */
export function readMaxConcurrentTurns(
  value: number | undefined,
  option: string
): number {
  if (value === undefined) {
    return DEFAULT_MAX_CONCURRENT_AGENT_TURNS;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return value;
}

/**
 * Reads the host's option into the settings the runtime carries.
 * `undefined` leaves the agent off, the turn limit of every value accepted is
 * checked, and any value that is neither a provider function's result nor
 * `{ runner }` throws.
 */
export function readAgentSettings(
  config: WfGraphAgentConfig | undefined
): AgentSettings {
  if (config === undefined) {
    return { enabled: false };
  }
  const model = agentModelSettings(config);
  if (model !== undefined) {
    return model.enabled
      ? {
          ...model,
          maxConcurrentTurns: readMaxConcurrentTurns(
            model.maxConcurrentTurns,
            "agent.maxConcurrentTurns"
          ),
        }
      : model;
  }
  if (typeof config === "object" && config !== null && "runner" in config) {
    return {
      enabled: true,
      runner: config.runner,
      maxConcurrentTurns: readMaxConcurrentTurns(
        config.maxConcurrentTurns,
        "agent.maxConcurrentTurns"
      ),
    };
  }
  throw new Error(
    "agent takes what a provider function returns, such as wfOpenAi from @wfgraph/core/openai, or { runner }. Leave agent out to turn the build agent off."
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
