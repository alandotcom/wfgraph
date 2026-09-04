/**
 * Internal contract between turn orchestration and an agent implementation.
 *
 * A runner receives one request-scoped tool session and emits the existing
 * browser stream. The scoped adapter aborts the runner when stream consumption
 * ends, including request cancellation.
 */

import { Context, Effect, Layer, Stream } from "effect";
import type {
  AgentMessage,
  AgentStreamPart,
} from "@wfgraph/shared/rpc/agent-stream";
import type { AgentToolSession } from "#src/backend/agent/tool-session";
import type { AgentTraceObserver } from "#src/backend/agent/trace";

export type AgentRunnerMetadata = {
  readonly provider: string;
  readonly model: string;
};

export type AgentRunnerInput = {
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
