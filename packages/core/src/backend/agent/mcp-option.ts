/**
 * The startup check on the host's `mcp` option. It imports the option's type
 * alone, so `createWfGraphApp` and `wfWorker` can check the option without
 * loading the MCP server, which only the `@wfgraph/core/mcp` entry reaches.
 */

import type { WfGraphMcp } from "#src/backend/agent/mcp-server";

/**
 * The `mcp` option as the host passed it, once checked. `undefined` leaves the
 * endpoint off. Any value `wfMcp` did not build throws, which is what a
 * JavaScript host passing `true` or a plain object of hostnames gets.
 */
export function readMcpOption(
  mcp: WfGraphMcp | undefined,
  caller: string
): WfGraphMcp | undefined {
  if (mcp === undefined) {
    return undefined;
  }
  if (typeof mcp === "object" && mcp !== null && "createHandler" in mcp) {
    return mcp;
  }
  return unknownMcpOption(mcp, caller);
}

function unknownMcpOption(_mcp: never, caller: string): never {
  throw new Error(
    `${caller}'s mcp option takes what wfMcp from @wfgraph/core/mcp returns: wfMcp() for localhost, or wfMcp({ allowedHostnames, allowedOriginHostnames }) for a deployed hostname.`
  );
}
