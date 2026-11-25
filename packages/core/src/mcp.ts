/**
 * The MCP authoring endpoint. Pass what `wfMcp` returns as the `mcp` option
 * of `createWfGraphApp` or `wfWorker`. This is the one entry that loads
 * `@modelcontextprotocol/server`.
 */

export {
  wfMcp,
  type WfGraphMcpAuthorization,
  type WfGraphMcpOptions,
} from "#src/backend/agent/mcp-server";
