import { eventIterator } from "@orpc/contract";
import { Schema } from "effect";
import { serializedWorkflowGraphSchema } from "#src/graph/schemas";
import {
  agentMessageSchema,
  agentStreamPartSchema,
} from "#src/rpc/agent-stream";
import { listOf } from "#src/types/schema";
import { WfGraphOperations } from "#src/authorization/operations";
import {
  contractSchema,
  idSchema,
  route,
} from "#src/rpc/contracts/contract-support";

/**
 * The build agent's one procedure, and the only streaming contract in the repo.
 *
 * `eventIterator` is oRPC's async-iterator output: the handler is a generator
 * and `RPCLink` hands the browser an async iterable, so the chat panel reads a
 * turn as it is produced without a second transport beside the RPC client.
 *
 * The turn carries the whole conversation and the whole graph, because neither
 * is kept on the server. Nothing about a turn outlives the request that ran it.
 */
export const MAX_AGENT_MESSAGES = 100;
export const MAX_AGENT_MESSAGE_CHARS = 32_000;
export const MAX_AGENT_GRAPH_NODES = 500;
export const MAX_AGENT_GRAPH_EDGES = 2_000;
export const MAX_AGENT_REQUEST_CHARS = 1_000_000;

const boundedAgentMessageSchema = agentMessageSchema.check(
  Schema.makeFilter(
    (message) => message.content.length <= MAX_AGENT_MESSAGE_CHARS,
    { expected: `a message of at most ${MAX_AGENT_MESSAGE_CHARS} characters` }
  )
);

const boundedAgentGraphSchema = serializedWorkflowGraphSchema.check(
  Schema.makeFilter(
    (graph) =>
      graph.nodes.length <= MAX_AGENT_GRAPH_NODES &&
      graph.edges.length <= MAX_AGENT_GRAPH_EDGES,
    {
      expected: `a graph with at most ${MAX_AGENT_GRAPH_NODES} nodes and ${MAX_AGENT_GRAPH_EDGES} edges`,
    }
  )
);

export const agentChatInputSchema = Schema.Struct({
  workflowId: idSchema,
  messages: listOf(boundedAgentMessageSchema).check(
    Schema.isMaxLength(MAX_AGENT_MESSAGES)
  ),
  graph: boundedAgentGraphSchema,
}).check(
  Schema.makeFilter(
    (input) => JSON.stringify(input).length <= MAX_AGENT_REQUEST_CHARS,
    {
      expected: `an agent request of at most ${MAX_AGENT_REQUEST_CHARS} characters`,
    }
  )
);

const agentChatInput = contractSchema(agentChatInputSchema);

export const agentContract = {
  chat: route("POST", "/agent/chat", WfGraphOperations.agentChat)
    .input(agentChatInput)
    .output(eventIterator(contractSchema(agentStreamPartSchema))),
};
