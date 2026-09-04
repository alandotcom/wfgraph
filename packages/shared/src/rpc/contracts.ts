import {
  agentChatInputSchema,
  agentContract,
  MAX_AGENT_GRAPH_EDGES,
  MAX_AGENT_GRAPH_NODES,
  MAX_AGENT_MESSAGE_CHARS,
  MAX_AGENT_MESSAGES,
  MAX_AGENT_REQUEST_CHARS,
} from "#src/rpc/contracts/agent";
import {
  getWfGraphOperation,
  wfGraphOperationMeta,
} from "#src/rpc/contracts/contract-support";
import { integrationContract } from "#src/rpc/contracts/integrations";
import { workflowContract } from "#src/rpc/contracts/workflows";

export {
  agentChatInputSchema,
  getWfGraphOperation,
  MAX_AGENT_GRAPH_EDGES,
  MAX_AGENT_GRAPH_NODES,
  MAX_AGENT_MESSAGE_CHARS,
  MAX_AGENT_MESSAGES,
  MAX_AGENT_REQUEST_CHARS,
  wfGraphOperationMeta,
};

export const rpcContract = {
  agent: agentContract,
  integration: integrationContract,
  workflow: workflowContract,
};

export type RpcContract = typeof rpcContract;
