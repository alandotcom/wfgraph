/**
 * The MCP authoring endpoint. Pass what `wfMcp` returns as the `mcp` option
 * of `createWfGraphApp` or `wfWorker`.
 */

export { wfMcp } from "#src/backend/agent/mcp-http";
export type {
  WfGraphMcpAuthorization,
  WfGraphMcpOptions,
} from "#src/backend/agent/mcp-option";
