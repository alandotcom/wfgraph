/**
 * The MCP endpoint's HTTP edge, and `wfMcp`, which builds the `mcp` option
 * from it: the Host and Origin check, the protected-resource metadata, the
 * 401 challenge, and the per-request handler serving `createAgentMcpServer`.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  INVALID_PARAMS,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  type McpHttpHandler,
  type OAuthProtectedResourceMetadata,
  PROTOCOL_VERSION_META_KEY,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  type CreateAgentMcpServerInput,
  type McpEndpointRequest,
  mcpOption,
  type WfGraphMcp,
  type WfGraphMcpAuthorization,
  type WfGraphMcpOptions,
} from "#src/backend/agent/mcp-option";
import { createAgentMcpServer } from "#src/backend/agent/mcp-server";

/**
 * The endpoint's options as `wfMcp` resolved them. `localhostDefaults` is true
 * when the host passed no options, which changes what a refusal tells the
 * host to write.
 */
type McpHttpSecurity = {
  readonly options: WfGraphMcpOptions;
  readonly localhostDefaults: boolean;
};

/** A 403 refusal of the request's routing headers, as a JSON-RPC error. */
function routingRefusal(message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32_000, message }, id: null },
    { status: 403 }
  );
}

/**
 * Rejects untrusted HTTP routing headers before any MCP body is read. Each
 * refusal names the option that admits the hostname and leaves the hostname
 * itself out, since it is what the sender typed.
 */
function mcpHttpValidationResponse(
  request: Request,
  security: McpHttpSecurity
): Response | undefined {
  const { options } = security;
  const localhostHint =
    "`wfMcp()` admits localhost alone; pass `wfMcp({ allowedHostnames, allowedOriginHostnames })` to admit another hostname";
  const host = validateHostHeader(request.headers.get("host"), [
    ...options.allowedHostnames,
  ]);
  if (!host.ok) {
    return routingRefusal(
      host.errorCode === "invalid_host"
        ? `The Host header names a hostname this MCP endpoint does not accept. ${security.localhostDefaults ? localhostHint : "Add the hostname to the allowedHostnames option of wfMcp"}.`
        : "The request carries no valid Host header."
    );
  }
  const origin = validateOriginHeader(request.headers.get("origin"), [
    ...options.allowedOriginHostnames,
  ]);
  if (!origin.ok) {
    return routingRefusal(
      origin.errorCode === "invalid_origin"
        ? `The Origin header names a hostname this MCP endpoint does not accept from a browser. ${security.localhostDefaults ? localhostHint : "Add the hostname to the allowedOriginHostnames option of wfMcp"}.`
        : "The request carries an Origin header that is not a valid origin."
    );
  }
  return undefined;
}

/**
 * The canonical URL of the MCP endpoint, which is the `resource` an access
 * token is issued for.
 */
function mcpResourceUrl(input: McpEndpointRequest): URL {
  return new URL(input.mcpPath, input.publicUrl ?? input.request.url);
}

/**
 * The RFC 9728 path of the protected-resource metadata for an endpoint at
 * `mcpPath`: the well-known prefix inserted ahead of the endpoint's path.
 */
function mcpProtectedResourceMetadataPath(mcpPath: string): string {
  return new URL(
    getOAuthProtectedResourceMetadataUrl(new URL(mcpPath, "http://localhost"))
  ).pathname;
}

/** The protected-resource metadata document. */
function mcpProtectedResourceMetadataResponse(
  input: McpEndpointRequest,
  authorization: WfGraphMcpAuthorization
): Response {
  const metadata: OAuthProtectedResourceMetadata = omitUndefined({
    resource: mcpResourceUrl(input).href,
    authorization_servers: [...authorization.authorizationServers],
    scopes_supported:
      authorization.scopesSupported === undefined
        ? undefined
        : [...authorization.scopesSupported],
    bearer_methods_supported: ["header"],
  });
  return Response.json(metadata, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * The `WWW-Authenticate` value a 401 on the MCP endpoint carries: the
 * metadata URL and scopes when the host named an authorization server, and a
 * bare Bearer challenge otherwise.
 */
function mcpAuthenticationChallenge(
  input: McpEndpointRequest,
  authorization: WfGraphMcpAuthorization | undefined
): string {
  if (authorization === undefined) {
    return "Bearer";
  }
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(
    mcpResourceUrl(input)
  );
  const scope = authorization.scopesSupported?.join(" ");
  return scope
    ? `Bearer resource_metadata="${metadataUrl}", scope="${scope}"`
    : `Bearer resource_metadata="${metadataUrl}"`;
}

function invalidParamsResponse(body: JsonObject, message: string): Response {
  const id = body.id;
  return Response.json(
    {
      jsonrpc: "2.0",
      id: typeof id === "string" || typeof id === "number" ? id : null,
      error: { code: INVALID_PARAMS, message },
    },
    { status: 400 }
  );
}

/**
 * Creates a handler whose factory builds one server per request. A 2026-07-28
 * request is served directly; a 2025-era request (protocol revisions
 * 2024-10-07 through 2025-11-25) is served by the SDK's stateless legacy path,
 * which answers `initialize` from a fresh server and refuses the session
 * methods `GET` and `DELETE` with 405. The server keeps no state between calls
 * in either era, so both serve the same tools against the same stored draft.
 */
function createAgentMcpHandler(
  input: CreateAgentMcpServerInput
): McpHttpHandler {
  const handler = createMcpHandler(() => createAgentMcpServer(input), {
    legacy: "stateless",
  });

  return {
    ...handler,
    fetch: async (request, options) => {
      if (request.method === "POST") {
        try {
          const body = readJsonObject(
            options?.parsedBody ?? (await request.clone().json())
          );
          const params = readJsonObject(body?.params);
          const meta = readJsonObject(params?.["_meta"]);
          const method = body?.method;
          const name = params?.name;
          const standardHeadersMatch =
            request.headers.get("MCP-Protocol-Version") === "2026-07-28" &&
            request.headers.get("Mcp-Method") === method &&
            (method !== "tools/call" ||
              request.headers.get("Mcp-Name") === name);

          if (
            meta?.[PROTOCOL_VERSION_META_KEY] === "2026-07-28" &&
            standardHeadersMatch
          ) {
            if (
              readJsonObject(meta[CLIENT_INFO_META_KEY]) === null ||
              readJsonObject(meta[CLIENT_CAPABILITIES_META_KEY]) === null
            ) {
              return invalidParamsResponse(
                body ?? {},
                "Request _meta requires client identity and capabilities"
              );
            }
          }
        } catch {
          // The SDK owns JSON and JSON-RPC parse errors.
        }
      }

      return await handler.fetch(request, options);
    },
  };
}

/**
 * Enables the authenticated stateless MCP endpoint at `${basePath}/api/mcp`.
 * Pass what it returns as the `mcp` option. With no argument the endpoint
 * admits localhost alone, in the Host header and in a browser's Origin
 * header; `options` names the hostnames a deployed endpoint admits and the
 * authorization servers a 401 sends an MCP client to.
 */
export function wfMcp(options?: WfGraphMcpOptions): WfGraphMcp {
  const httpSecurity: McpHttpSecurity =
    options === undefined
      ? {
          options: {
            allowedHostnames: localhostAllowedHostnames(),
            allowedOriginHostnames: localhostAllowedOrigins(),
          },
          localhostDefaults: true,
        }
      : { options, localhostDefaults: false };
  const { authorization } = httpSecurity.options;
  return mcpOption({
    refuseUntrustedHeaders: (request) =>
      mcpHttpValidationResponse(request, httpSecurity),
    metadata:
      authorization === undefined
        ? undefined
        : {
            path: mcpProtectedResourceMetadataPath,
            response: (input) =>
              mcpProtectedResourceMetadataResponse(input, authorization),
          },
    authenticationChallenge: (input) =>
      mcpAuthenticationChallenge(input, authorization),
    createHandler: createAgentMcpHandler,
  });
}
