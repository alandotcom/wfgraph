/**
 * Owns the short-lived MCP transports created for active editor turns.
 *
 * A random bearer credential selects one turn-scoped draft. The registry never
 * reads a persisted workflow and removes the credential before closing a session.
 */

import {
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
} from "@modelcontextprotocol/server";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { AgentStreamPart } from "@wfgraph/shared/rpc/agent-stream";
import type { AuthContext } from "#src/backend/lib/http/authorize";
import {
  MAX_REQUEST_BODY_BYTES,
  readCappedText,
} from "#src/backend/lib/http/capped-body";
import { createAgentMcpServer } from "#src/backend/agent/mcp-server";
import type { AgentToolSession } from "#src/backend/agent/tool-session";
import type { AgentTraceObserver } from "#src/backend/agent/trace";

const UNAUTHORIZED_RESPONSE = { error: "Unauthorized" } as const;
const FORBIDDEN_RESPONSE = { error: "Forbidden" } as const;
const TOO_LARGE_RESPONSE = { error: "Request body is too large" } as const;

export type AgentMcpConnection = {
  readonly url: string;
  readonly headers: Readonly<Record<"Authorization", string>>;
  readonly close: () => Promise<void>;
};

export type OpenAgentMcpSessionInput = {
  readonly workflowId: string;
  readonly authorization: AuthContext;
  readonly session: AgentToolSession;
  readonly observeTrace: AgentTraceObserver;
  readonly emitPart: (part: AgentStreamPart) => void | Promise<void>;
};

type ActiveSession = {
  readonly workflowId: string;
  readonly authorization: AuthContext;
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly close: () => Promise<void>;
};

export type AgentMcpSessionRegistry = {
  readonly open: (
    input: OpenAgentMcpSessionInput
  ) => Promise<AgentMcpConnection>;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
};

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token || undefined;
}

function jsonResponse(
  body: { readonly error: string },
  status: 401 | 403 | 413
): Response {
  return Response.json(body, {
    status,
    headers: status === 401 ? { "WWW-Authenticate": "Bearer" } : {},
  });
}

async function withCappedBody(
  request: Request,
  limitBytes: number
): Promise<Request | Response> {
  if (request.method !== "POST") {
    return request;
  }
  const body = await readCappedText(request, limitBytes);
  if (!body.ok) {
    return jsonResponse(TOO_LARGE_RESPONSE, 413);
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: body.text,
    signal: request.signal,
  });
}

/** Creates the app-owned registry used by the MCP HTTP route and custom runner. */
export function createAgentMcpSessionRegistry(options: {
  readonly url: string;
  readonly requestBodyLimit?: number | undefined;
}): AgentMcpSessionRegistry {
  const sessions = new Map<string, ActiveSession>();
  const requestBodyLimit = options.requestBodyLimit ?? MAX_REQUEST_BODY_BYTES;
  let closed = false;

  return {
    open: async (input) => {
      if (closed) {
        throw new Error("The MCP session registry is closed");
      }
      if (!(await input.authorization.allows(WfGraphOperations.agentChat))) {
        throw new Error(
          "The operator is not authorized to use the build agent"
        );
      }

      const token = crypto.randomUUID();
      let sessionClosed = false;
      const server = createAgentMcpServer({
        session: input.session,
        observeTrace: input.observeTrace,
        emitPart: input.emitPart,
      });
      const close = async () => {
        if (sessionClosed) return;
        sessionClosed = true;
        sessions.delete(token);
        await server.close();
      };
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessionclosed: close,
      });

      await server.connect(transport);
      sessions.set(token, {
        workflowId: input.workflowId,
        authorization: input.authorization,
        server,
        transport,
        close,
      });

      return {
        url: options.url,
        headers: { Authorization: `Bearer ${token}` },
        close,
      };
    },

    fetch: async (request) => {
      const token = bearerToken(request);
      const session = token ? sessions.get(token) : undefined;
      if (!session) {
        return jsonResponse(UNAUTHORIZED_RESPONSE, 401);
      }
      if (!(await session.authorization.allows(WfGraphOperations.agentChat))) {
        return jsonResponse(FORBIDDEN_RESPONSE, 403);
      }

      const cappedRequest = await withCappedBody(request, requestBodyLimit);
      if (cappedRequest instanceof Response) {
        return cappedRequest;
      }
      return await session.transport.handleRequest(cappedRequest);
    },

    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all(
        [...sessions.values()].map((session) => session.close())
      );
    },
  };
}
