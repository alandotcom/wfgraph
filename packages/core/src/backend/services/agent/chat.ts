/**
 * The build agent's one procedure, as a service.
 *
 * It gathers what a turn needs from the runtime -- the catalog, the operator's
 * connections and the model settings -- and hands the AI machinery in
 * `backend/agent/` a plain value. Nothing about a turn is stored, so this is the
 * whole of the server's memory of one.
 */

import { Cause, Effect, Exit, Semaphore, Stream } from "effect";
import type { Response } from "effect/unstable/ai";
import type { AgentDocument } from "@wfgraph/agent/document";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type {
  AgentMessage,
  AgentStreamPart,
} from "@wfgraph/shared/rpc/agent-stream";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import {
  AgentCapacity,
  AgentConfig,
  agentDisabledMessage,
} from "#src/backend/agent/config";
import { AgentRunnerService, runAgentRunner } from "#src/backend/agent/runner";
import { makeAgentToolSession } from "#src/backend/agent/tool-session";
import {
  finishReasonFailure,
  makeAgentTraceAccumulator,
  type AgentTraceAccumulator,
} from "#src/backend/agent/trace";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
import { internalFailure } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { getErrorMessage } from "@wfgraph/shared/utils";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { validateAgentDraft } from "#src/backend/agent/publication-validation";

const AGENT_BUSY_MESSAGE =
  "The build agent is busy with other turns. Wait for one to finish and try again.";

type AgentTurnStatus = "completed" | "incomplete" | "failed" | "cancelled";
type AgentTurnLogLevel = "info" | "warn";

/** Classifies the provider stream result for the one completion log record. */
export function agentTurnStatus(
  exit: Exit.Exit<unknown, unknown>,
  finishReason: Response.FinishReason | undefined
): AgentTurnStatus {
  if (Exit.isSuccess(exit)) {
    return "completed";
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return "cancelled";
  }
  return finishReason && finishReasonFailure(finishReason)
    ? "incomplete"
    : "failed";
}

export function agentTurnLogLevel(status: AgentTurnStatus): AgentTurnLogLevel {
  return status === "failed" || status === "incomplete" ? "warn" : "info";
}

export type ObserveAgentTurnInput = {
  readonly parts: Stream.Stream<AgentStreamPart, unknown>;
  readonly trace: AgentTraceAccumulator;
  readonly logger: EffectLogger;
  readonly workflowId: string;
  readonly messageCount: number;
  readonly model: string;
  readonly startedAt: number;
  readonly now: () => number;
};

/** Records one aggregate completion line and maps stream failures to browser errors. */
export function observeAgentTurn(
  input: ObserveAgentTurnInput
): Stream.Stream<AgentStreamPart> {
  const completed = input.parts.pipe(
    Stream.onExit((exit) => {
      const summary = input.trace.summary();
      const status = agentTurnStatus(exit, summary.finishReason);
      const failureMessage =
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? getErrorMessage(Cause.squash(exit.cause))
          : undefined;

      return input.logger[agentTurnLogLevel(status)](
        "Agent turn finished",
        omitUndefined({
          run: {
            workflowId: input.workflowId,
            status,
            messages: input.messageCount,
            ms: input.now() - input.startedAt,
          },
          model: omitUndefined({
            id: input.model,
            calls: summary.modelCalls,
            finishReason: summary.finishReason,
            finishReasons: summary.finishReasons,
          }),
          tools: {
            calls: summary.toolCalls,
            refusals: summary.refusals,
            graphRevisions: summary.graphRevisions,
          },
          usage: {
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
            reasoningTokens: summary.reasoningTokens,
            totalTokens: summary.totalTokens,
          },
          error: failureMessage ? { message: failureMessage } : undefined,
        })
      );
    })
  );

  return observeAgentStream(completed, () => Effect.void);
}

/** Maps a running failure to the stream contract after recording its full cause. */
export function observeAgentStream(
  parts: Stream.Stream<AgentStreamPart, unknown>,
  onFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
): Stream.Stream<AgentStreamPart> {
  return parts.pipe(
    Stream.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Stream.empty
        : Stream.fromEffect(onFailure(cause)).pipe(
            Stream.flatMap(() =>
              Stream.succeed<AgentStreamPart>({
                type: "error",
                message: getErrorMessage(Cause.squash(cause)),
              })
            )
          )
    )
  );
}

/** Holds one application permit for the complete lifetime of a model stream. */
export function limitAgentStream(
  parts: Stream.Stream<AgentStreamPart>,
  capacity: Semaphore.Semaphore
): Stream.Stream<AgentStreamPart> {
  return Stream.scoped(
    Stream.fromEffect(
      Effect.acquireRelease(capacity.takeIfAvailable(1), (acquired) =>
        acquired ? capacity.release(1).pipe(Effect.asVoid) : Effect.void
      )
    ).pipe(
      Stream.flatMap((acquired) =>
        acquired
          ? parts
          : Stream.succeed({ type: "error", message: AGENT_BUSY_MESSAGE })
      )
    )
  );
}

export type PostAgentChatInput = {
  readonly workflowId: string;
  readonly messages: readonly AgentMessage[];
  readonly graph: SerializedWorkflowGraph;
};

/**
 * The graph the editor sent, in the node-and-edge shape the tools edit.
 *
 * The wire form is graphology's, because that is what every other write to a
 * workflow already carries.
 */
function toDocument(graph: SerializedWorkflowGraph): AgentDocument {
  return toWorkflowGraphData(graph);
}

export const postAgentChat = Effect.fn("postAgentChat")(function* (
  input: PostAgentChatInput
) {
  const settings = yield* AgentConfig;
  if (!settings.enabled) {
    return yield* new NotFound({ error: agentDisabledMessage() });
  }

  const { catalog } = yield* Extensions;
  const repo = yield* IntegrationRepo;
  const logger = (yield* AppLogger).get("agent");
  const capacity = yield* AgentCapacity;
  const runner = yield* AgentRunnerService;

  const integrations = yield* repo.listIdentities.pipe(
    Effect.catchTag(
      "DatabaseError",
      internalFailure(logger, "Failed to read integrations for the agent")
    )
  );

  const startedAt = Date.now();
  const trace = makeAgentTraceAccumulator();
  const session = yield* makeAgentToolSession({
    catalog,
    integrations,
    document: toDocument(input.graph),
    validateDraft: (document) =>
      validateAgentDraft({
        document,
        catalog,
        integrations,
      }),
  });
  const stream = runAgentRunner(runner, {
    messages: input.messages,
    session,
    observeTrace: trace.observe,
  });

  return limitAgentStream(
    observeAgentTurn({
      parts: stream,
      trace,
      logger,
      workflowId: input.workflowId,
      messageCount: input.messages.length,
      model: runner.metadata.model,
      startedAt,
      now: Date.now,
    }),
    capacity
  );
});
