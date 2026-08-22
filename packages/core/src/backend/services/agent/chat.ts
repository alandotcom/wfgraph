/**
 * The build agent's one procedure, as a service.
 *
 * It gathers what a turn needs from the runtime -- the catalog, the operator's
 * connections and the model settings -- and hands the AI machinery in
 * `backend/agent/` a plain value. Nothing about a turn is stored, so this is the
 * whole of the server's memory of one.
 */

import { Cause, Effect, Semaphore, Stream } from "effect";
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
import { runAgentTurn } from "#src/backend/agent/chat";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailure } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import { ENCRYPTION_KEY_MISMATCH_MESSAGE } from "#src/backend/services/integrations/cipher";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { getErrorMessage } from "@wfgraph/shared/utils";

const AGENT_BUSY_MESSAGE =
  "The build agent is busy with other turns. Wait for one to finish and try again.";

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
  return Stream.fromEffect(capacity.takeIfAvailable(1)).pipe(
    Stream.flatMap((acquired) =>
      acquired
        ? parts.pipe(Stream.ensuring(capacity.release(1).pipe(Effect.asVoid)))
        : Stream.succeed({ type: "error", message: AGENT_BUSY_MESSAGE })
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

  // `listByType` fails two ways, and neither is a sentence a caller can act on,
  // so both become one internal failure with the cause on the log record.
  const integrations = yield* repo.listByType().pipe(
    Effect.catchTags({
      DatabaseError: internalFailure(
        logger,
        "Failed to read integrations for the agent"
      ),
      EncryptionKeyMismatch: internalFailure(
        logger,
        ENCRYPTION_KEY_MISMATCH_MESSAGE
      ),
    })
  );

  const stream = yield* runAgentTurn({
    settings,
    catalog,
    integrations: integrations.map((integration) => ({
      id: integration.id,
      type: integration.type,
    })),
    document: toDocument(input.graph),
    messages: input.messages,
  });

  const observed = observeAgentStream(stream, (cause) =>
    logger.warn("Agent turn failed", {
      run: { workflowId: input.workflowId },
      error: { message: getErrorMessage(Cause.squash(cause)) },
    })
  );
  const started = Stream.fromEffect(
    logger.info("Agent turn started", {
      run: { workflowId: input.workflowId, messages: input.messages.length },
    })
  ).pipe(Stream.flatMap(() => observed));

  return limitAgentStream(started, capacity);
});
