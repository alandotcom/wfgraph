/**
 * Task check for the wfgraph-core/mcp skill: a host deployed at
 * `workflows.example.com` lets an MCP client author workflows with a bearer
 * token its own authorization server issued, while the editor keeps signing in
 * with a session cookie. The developer task is "connect our coding agent to the
 * deployed workflow editor".
 *
 * `expectMcpAccess` is the grader. It speaks the MCP wire protocol over HTTP,
 * the way a client does, and runs against the configuration the skill
 * recommends and against three mistakes the skill warns about, each of which it
 * must reject.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  defineWfGraphAuth,
  WfGraphRoles,
  type WfGraphApp,
  type WfGraphAuth,
  type WfGraphMcpOptions,
} from "@wfgraph/core";
import { openHost } from "#src/skills/host";

const HOST = "workflows.example.com";

/** The token the host's authorization server issued to the MCP client. */
const ISSUED_TOKEN = "mcp-token-1";

/** The editor's session cookie, which the MCP client never holds. */
const EDITOR_COOKIE = "session=editor";

/** The recommended endpoint options for a deployed host. */
const deployedMcp: WfGraphMcpOptions = {
  allowedHostnames: [HOST],
  allowedOriginHostnames: [],
  authorization: {
    authorizationServers: ["https://auth.example.com"],
    scopesSupported: ["workflows"],
  },
};

/** Stands in for the host verifying a token with its authorization server. */
function verifiedToken(request: Request): boolean {
  return request.headers.get("authorization") === `Bearer ${ISSUED_TOKEN}`;
}

/** The recommended policy: the editor's cookie, or a verified bearer token. */
const cookieOrTokenAuth = defineWfGraphAuth((request) => {
  if (request.headers.get("cookie") === EDITOR_COOKIE) {
    return WfGraphRoles.editor;
  }
  return verifiedToken(request) ? WfGraphRoles.editor : null;
});

/** A mistake: the policy the editor alone needs, which reads only the cookie. */
const cookieOnlyAuth = defineWfGraphAuth((request) =>
  request.headers.get("cookie") === EDITOR_COOKIE ? WfGraphRoles.editor : null
);

/** A mistake: any bearer token is taken as signed in, and none is verified. */
const anyBearerAuth = defineWfGraphAuth((request) => {
  if (request.headers.get("cookie") === EDITOR_COOKIE) {
    return WfGraphRoles.editor;
  }
  return request.headers.get("authorization")?.startsWith("Bearer ")
    ? WfGraphRoles.editor
    : null;
});

let nextRequestId = 1;

/**
 * One JSON-RPC request to the endpoint at protocol revision `2026-07-28`, with
 * the routing headers and the client identity a stateless request carries.
 */
async function mcpCall(
  app: WfGraphApp,
  input: {
    method: string;
    params?: Record<string, unknown>;
    toolName?: string;
    token?: string;
  }
): Promise<Response> {
  const headers = new Headers({
    host: HOST,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": input.method,
  });
  if (input.toolName !== undefined) headers.set("Mcp-Name", input.toolName);
  if (input.token !== undefined) {
    headers.set("authorization", `Bearer ${input.token}`);
  }
  const body = {
    jsonrpc: "2.0",
    id: nextRequestId++,
    method: input.method,
    params: {
      ...input.params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": {
          name: "skill-check",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  return await app.fetch(
    new Request(`https://${HOST}/api/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  );
}

const toolCallAnswer = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optionalKey(Schema.Boolean),
    structuredContent: Schema.optionalKey(Schema.Unknown),
  }),
});

const protectedResource = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
});

/**
 * The grader. Over HTTP it asserts that the issued token reaches the catalog
 * with no workflow and creates a workflow, that a client with no token is told
 * where to get one, that the metadata document names the authorization server,
 * that a wrong token is refused, and that the editor's cookie still signs in.
 */
async function expectMcpAccess(options: {
  auth: WfGraphAuth;
  mcp: true | WfGraphMcpOptions;
}): Promise<void> {
  await using app = await openHost(options);

  const catalog = await mcpCall(app, {
    method: "tools/call",
    toolName: "list_actions",
    params: { name: "list_actions", arguments: {} },
    token: ISSUED_TOKEN,
  });
  expect(catalog.status).toBe(200);
  const listed = Schema.decodeUnknownSync(toolCallAnswer)(await catalog.json());
  expect(listed.result.isError ?? false).toBe(false);

  const created = await mcpCall(app, {
    method: "tools/call",
    toolName: "create_workflow",
    params: { name: "create_workflow", arguments: { name: "From a client" } },
    token: ISSUED_TOKEN,
  });
  expect(created.status).toBe(200);
  const creation = Schema.decodeUnknownSync(toolCallAnswer)(
    await created.json()
  );
  expect(creation.result.isError ?? false).toBe(false);
  expect(creation.result.structuredContent).toMatchObject({
    workflowId: expect.any(String),
    draftRevision: expect.any(Number),
  });

  const anonymous = await mcpCall(app, { method: "tools/list" });
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get("www-authenticate")).toContain(
    "resource_metadata="
  );

  const metadata = await app.fetch(
    new Request(
      `https://${HOST}/.well-known/oauth-protected-resource/api/mcp`,
      {
        headers: { host: HOST },
      }
    )
  );
  expect(metadata.status).toBe(200);
  const document = Schema.decodeUnknownSync(protectedResource)(
    await metadata.json()
  );
  expect(document.authorization_servers).toEqual(["https://auth.example.com"]);

  const forged = await mcpCall(app, {
    method: "tools/list",
    token: "made-up-token",
  });
  expect(forged.status).toBe(401);

  const editor = await app.fetch(
    new Request(`https://${HOST}/api/extensions`, {
      headers: { host: HOST, cookie: EDITOR_COOKIE },
    })
  );
  expect(editor.status).toBe(200);
}

describe("wfgraph-core/mcp task check", () => {
  it("lets a client holding the issued token author, and tells one without a token where to get it", async () => {
    await expectMcpAccess({ auth: cookieOrTokenAuth, mcp: deployedMcp });
  });

  it("rejects an auth function that reads only the editor's cookie", async () => {
    await expect(
      expectMcpAccess({ auth: cookieOnlyAuth, mcp: deployedMcp })
    ).rejects.toThrow("expected 401 to be 200");
  });

  it("rejects an auth function that takes any bearer token as signed in", async () => {
    await expect(
      expectMcpAccess({ auth: anyBearerAuth, mcp: deployedMcp })
    ).rejects.toThrow("expected 200 to be 401");
  });

  it("rejects mcp: true on a deployed hostname", async () => {
    await expect(
      expectMcpAccess({ auth: cookieOrTokenAuth, mcp: true })
    ).rejects.toThrow("expected 403 to be 200");
  });
});
