/**
 * The build agent's one procedure, as a service.
 *
 * It gathers what a turn needs from the runtime -- the catalog, the operator's
 * connections and the model settings -- and hands the AI machinery in
 * `backend/agent/` a plain value. Nothing about a turn is stored, so this is the
 * whole of the server's memory of one.
 */

import { Effect } from "effect";
import type { AgentDocument } from "@wfgraph/agent/document";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type { AgentMessage } from "@wfgraph/shared/rpc/agent-stream";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import { AgentConfig, agentDisabledMessage } from "#src/backend/agent/config";
import { runAgentTurn } from "#src/backend/agent/chat";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailure } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import { ENCRYPTION_KEY_MISMATCH_MESSAGE } from "#src/backend/services/integrations/cipher";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";

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

  // One record for the turn, before any of it has been produced. What the turn
  // then says is the payload, and a payload is never logged.
  yield* logger.info("Agent turn started", {
    run: { workflowId: input.workflowId, messages: input.messages.length },
  });

  return stream;
});
