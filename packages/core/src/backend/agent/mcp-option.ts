/**
 * The `mcp` option's contract: the types a host writes, the members `wfMcp`
 * builds for `createApiApp` to mount the endpoint with, and the tool executors
 * those routes hand the endpoint. `readMcpOption` refuses every value `wfMcp`
 * did not build.
 */

import type { WorkflowSummaryPayload } from "@wfgraph/shared/graph/api-contracts";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { ServiceFailure } from "#src/backend/lib/effect/failures";
import type { AuthContext } from "#src/backend/lib/http/authorize";
import type {
  DraftToolResult,
  ExecuteDraftToolInput,
} from "#src/backend/services/agent/draft-tool";

/**
 * The OAuth 2.1 authorization servers a host names for its MCP endpoint.
 * Workflow Graph is never an authorization server: it advertises these in
 * the RFC 9728 protected-resource metadata, and the host's `auth` callback
 * still verifies every bearer token it receives.
 */
export type WfGraphMcpAuthorization = {
  /** Issuer URL of each authorization server that issues tokens for this endpoint. */
  readonly authorizationServers: readonly [string, ...string[]];
  /** Scopes the endpoint understands, sent as `scopes_supported` and in the 401 challenge. */
  readonly scopesSupported?: readonly string[] | undefined;
};

/** The options `wfMcp` takes for an endpoint on a deployed hostname. */
export type WfGraphMcpOptions = {
  /** Hostnames accepted from the HTTP Host header. Ports are ignored. */
  readonly allowedHostnames: readonly string[];
  /** Hostnames accepted from browser Origin headers. Ports are ignored. */
  readonly allowedOriginHostnames: readonly string[];
  /**
   * The authorization servers an MCP client is sent to on a 401. Absent, a
   * 401 carries a bare `WWW-Authenticate: Bearer` challenge and no metadata
   * document is served.
   */
  readonly authorization?: WfGraphMcpAuthorization | undefined;
};

/** The brand that marks the value `wfMcp` returns. */
const MCP_ENDPOINT: unique symbol = Symbol.for("@wfgraph/core/mcp-endpoint");

/**
 * What `wfMcp` from `@wfgraph/core/mcp` returns, which a host passes as the
 * `mcp` option of `createWfGraphApp` or `wfWorker`.
 */
export type WfGraphMcp = { readonly [MCP_ENDPOINT]: unknown };

export type DraftToolExecution =
  | { readonly ok: true; readonly result: DraftToolResult }
  | { readonly ok: false; readonly failure: ServiceFailure };

export type DraftToolExecutor = (
  input: ExecuteDraftToolInput,
  signal: AbortSignal
) => Promise<DraftToolExecution>;

export type WorkflowListExecution =
  | {
      readonly ok: true;
      readonly workflows: readonly WorkflowSummaryPayload[];
    }
  | { readonly ok: false; readonly failure: ServiceFailure };

export type WorkflowListExecutor = (
  signal: AbortSignal
) => Promise<WorkflowListExecution>;

export type WorkflowCreateExecution =
  | {
      readonly ok: true;
      readonly workflowId: string;
      readonly draftRevision: number;
    }
  | { readonly ok: false; readonly failure: ServiceFailure };

export type WorkflowCreateExecutor = (
  input: { readonly name: string; readonly description?: string | undefined },
  signal: AbortSignal
) => Promise<WorkflowCreateExecution>;

/**
 * One answer of a tool the host serves outside the toolkit. `isError` marks
 * an answer the tool refuses with, such as a publish the draft's blockers
 * stop, which still carries a structured result.
 */
export type HostToolExecution =
  | {
      readonly ok: true;
      readonly result: JsonObject;
      readonly isError?: boolean | undefined;
    }
  | { readonly ok: false; readonly failure: ServiceFailure };

/**
 * Publish, version history and restore. These are MCP tools only: the chat
 * panel's editor has its own Publish review and version history, and a chat
 * turn holds edits the editor has not stored yet, which a publish of the
 * stored draft would leave out.
 */
export type WorkflowPublicationExecutors = {
  readonly publish: (
    input: {
      readonly workflowId: string;
      readonly expectedDraftRevision: number;
    },
    signal: AbortSignal
  ) => Promise<HostToolExecution>;
  readonly listVersions: (
    input: { readonly workflowId: string },
    signal: AbortSignal
  ) => Promise<HostToolExecution>;
  readonly restore: (
    input: {
      readonly workflowId: string;
      readonly versionId: string;
      readonly expectedDraftRevision: number;
    },
    signal: AbortSignal
  ) => Promise<HostToolExecution>;
};

/** What one request's MCP server reads and writes through. */
export type CreateAgentMcpServerInput = {
  readonly auth: AuthContext;
  readonly execute: DraftToolExecutor;
  readonly listWorkflows: WorkflowListExecutor;
  readonly createWorkflow: WorkflowCreateExecutor;
  readonly publication: WorkflowPublicationExecutors;
};

/**
 * One request to the MCP endpoint, as the discovery answers read it.
 * `mcpPath` is the endpoint's absolute path. `publicUrl` is the host's
 * configured public origin when it has one, since a proxied request URL can
 * name an internal host.
 */
export type McpEndpointRequest = {
  readonly request: Request;
  readonly mcpPath: string;
  readonly publicUrl: string | undefined;
};

/** The handler for one request. The caller closes it once the response is sent. */
export type McpRequestHandler = {
  readonly fetch: (
    request: Request,
    options?: { readonly parsedBody?: unknown }
  ) => Promise<Response>;
  readonly close: () => Promise<void>;
};

/** The members `createApiApp` mounts the endpoint through. */
export type McpEndpoint = {
  /**
   * A 403 answer when the request's Host or Origin header names a hostname
   * the options do not admit, or undefined when both are admitted.
   */
  readonly refuseUntrustedHeaders: (request: Request) => Response | undefined;
  /**
   * The protected-resource metadata route, present only when the host named
   * an authorization server: its path for an endpoint at `mcpPath`, and the
   * document it answers.
   */
  readonly metadata?:
    | {
        readonly path: (mcpPath: string) => string;
        readonly response: (input: McpEndpointRequest) => Response;
      }
    | undefined;
  /** The `WWW-Authenticate` value a 401 from the endpoint carries. */
  readonly authenticationChallenge: (input: McpEndpointRequest) => string;
  /** A handler for one request, whose tools read and write through `input`. */
  readonly createHandler: (
    input: CreateAgentMcpServerInput
  ) => McpRequestHandler;
};

/** The value `wfMcp` returns, carrying `endpoint` under its brand. */
export function mcpOption(endpoint: McpEndpoint): WfGraphMcp {
  return { [MCP_ENDPOINT]: endpoint };
}

function isMcpOption(
  value: unknown
): value is { readonly [MCP_ENDPOINT]: McpEndpoint } {
  return typeof value === "object" && value !== null && MCP_ENDPOINT in value;
}

/**
 * The endpoint the host's `mcp` option carries. `undefined` leaves the
 * endpoint off, and any value `wfMcp` did not build throws.
 */
export function readMcpOption(
  mcp: WfGraphMcp | undefined,
  caller: string
): McpEndpoint | undefined {
  if (mcp === undefined) {
    return undefined;
  }
  if (isMcpOption(mcp)) {
    return mcp[MCP_ENDPOINT];
  }
  throw new Error(
    `${caller}'s mcp option takes what wfMcp from @wfgraph/core/mcp returns: wfMcp() for localhost, or wfMcp({ allowedHostnames, allowedOriginHostnames }) for a deployed hostname. Leave mcp out to turn the endpoint off.`
  );
}
