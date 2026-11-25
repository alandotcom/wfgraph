import { describe, expect, it } from "vitest";
import { wfMcp } from "#src/backend/agent/mcp-http";
import { readMcpOption, type WfGraphMcp } from "#src/backend/agent/mcp-option";

describe("readMcpOption", () => {
  it("leaves the endpoint off when the host passes nothing", () => {
    expect(readMcpOption(undefined, "createWfGraphApp")).toBeUndefined();
  });

  it("reads what wfMcp returned, with a metadata route only for an authorization server", () => {
    expect(readMcpOption(wfMcp(), "createWfGraphApp")).toMatchObject({
      createHandler: expect.any(Function),
      metadata: undefined,
    });
    const deployed = readMcpOption(
      wfMcp({
        allowedHostnames: ["workflows.example.com"],
        allowedOriginHostnames: [],
        authorization: { authorizationServers: ["https://auth.example.com"] },
      }),
      "createWfGraphApp"
    );
    expect(deployed?.metadata?.path("/api/mcp")).toBe(
      "/.well-known/oauth-protected-resource/api/mcp"
    );
  });

  // A JavaScript host can pass any value. Each one here is something other
  // than what `wfMcp` returns, including a hand-built object holding the
  // members core mounts the endpoint through.
  it.each([
    ["null", null],
    ["false", false],
    ["an empty string", ""],
    ["true", true],
    [
      "a plain object of hostnames",
      { allowedHostnames: ["localhost"], allowedOriginHostnames: [] },
    ],
    [
      "a hand-built object of endpoint members",
      {
        refuseUntrustedHeaders: () => undefined,
        authenticationChallenge: () => "Bearer",
        createHandler: () => undefined,
      },
    ],
  ])(
    "refuses %s, naming wfMcp and how to turn the endpoint off",
    (_label, mcp) => {
      expect(() =>
        readMcpOption(mcp as unknown as WfGraphMcp, "wfWorker")
      ).toThrow(
        "wfWorker's mcp option takes what wfMcp from @wfgraph/core/mcp returns: wfMcp() for localhost, or wfMcp({ allowedHostnames, allowedOriginHostnames }) for a deployed hostname. Leave mcp out to turn the endpoint off."
      );
    }
  );
});
