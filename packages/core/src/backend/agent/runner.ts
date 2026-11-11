/**
 * The contract between turn orchestration and an agent implementation.
 *
 * `AgentRunner` is the internal one: it receives one request-scoped tool
 * session and emits the browser stream, and the scoped adapter aborts it when
 * stream consumption ends, including request cancellation. `WfGraphAgentRunner`
 * is the public one a host passes as `agent.runner`; `agent/chat.ts` adapts it
 * to the internal contract and adds what the host should not have to write:
 * the canvas's `graph` parts and the turn's log counts.
 */

import { Context, Effect, Layer, Stream } from "effect";
import type { Prompt, Toolkit } from "effect/ai";
import type { agentToolkit } from "@wfgraph/agent/toolkit";
import type {
  AgentMessage,
  AgentStreamPart,
} from "@wfgraph/shared/rpc/agent-stream";
import type { AgentToolSession } from "#src/backend/agent/tool-session";
import type { AgentTraceObserver } from "#src/backend/agent/trace";

/** Every authoring tool, bound to one turn's draft. */
export type WfGraphAgentToolkit = Toolkit.WithHandler<
  Toolkit.Tools<typeof agentToolkit>
>;

/** One turn, as a host's runner receives it. */
export type WfGraphAgentTurn = {
  /** The workflow the editor has open. */
  readonly workflowId: string;
  /** The conversation as the browser sent it, the newest message last. */
  readonly messages: readonly AgentMessage[];
  /**
   * The same conversation as an Effect AI prompt, with the built-in system
   * prompt set and each past turn's record of tool calls written into it, ready
   * for `LanguageModel.streamText`.
   */
  readonly prompt: Prompt.Prompt;
  /**
   * The authoring tools. Each call reads and writes this turn's draft, and the
   * editor draws the draft after every successful write the stream reports.
   */
  readonly toolkit: WfGraphAgentToolkit;
  /** Aborted when the editor stops the turn or the request ends. */
  readonly signal: AbortSignal;
};

/**
 * A host's own agent, passed as `agent.runner`.
 *
 * `run` answers the parts the panel renders. A `tool-result` part for a write
 * tool that did not fail is followed by a `graph` part the server reads off
 * the draft, so a runner never emits one: a `graph` part it does emit is
 * dropped. A `usage` part it emits is added to the turn's counts, and the
 * server closes the turn with one `usage` part of its own. A failure in the
 * stream reaches the panel as an `error` part.
 */
export type WfGraphAgentRunner = {
  /** Named in the turn's log record. */
  readonly provider: string;
  /** Named in the turn's log record. */
  readonly model: string;
  readonly run: (
    turn: WfGraphAgentTurn
  ) => Stream.Stream<AgentStreamPart, unknown>;
};

export type AgentRunnerMetadata = {
  readonly provider: string;
  readonly model: string;
};

export type AgentRunnerInput = {
  readonly workflowId: string;
  readonly messages: readonly AgentMessage[];
  readonly session: AgentToolSession;
  readonly signal: AbortSignal;
  readonly observeTrace: AgentTraceObserver;
};

export type AgentRunner = {
  readonly metadata: AgentRunnerMetadata;
  readonly run: (
    input: AgentRunnerInput
  ) => Effect.Effect<Stream.Stream<AgentStreamPart, unknown>, unknown>;
};

export class AgentRunnerService extends Context.Service<
  AgentRunnerService,
  AgentRunner
>()("@wfgraph/core/AgentRunner") {}

export function makeAgentRunnerLayer(
  runner: AgentRunner
): Layer.Layer<AgentRunnerService> {
  return Layer.succeed(AgentRunnerService, AgentRunnerService.of(runner));
}

/** Runtime placeholder used while the agent feature is disabled. */
export const disabledAgentRunner: AgentRunner = {
  metadata: { provider: "none", model: "disabled" },
  run: () => Effect.die("Disabled agent runner was invoked"),
};

export type RunAgentRunnerInput = Omit<AgentRunnerInput, "signal">;

/** Runs a runner under a signal scoped to consumption of its output stream. */
export function runAgentRunner(
  runner: AgentRunner,
  input: RunAgentRunnerInput
): Stream.Stream<AgentStreamPart, unknown> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const signal = yield* Effect.abortSignal;
      return yield* runner.run({
        ...input,
        signal,
      });
    })
  );
}
