import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  type JsonObject,
  type JsonValue,
  readJsonObject,
} from "@wfgraph/shared/types/json";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";

export function rpcUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

export async function parseRpcRequestInput(
  init?: RequestInit
): Promise<JsonObject> {
  if (!init?.body) {
    return {};
  }

  const text =
    typeof init.body === "string"
      ? init.body
      : await new Response(init.body).text();

  if (!text) {
    return {};
  }

  const parsed = readJsonObject(JSON.parse(text));

  // The RPC wire envelope wraps the procedure's input under `json`.
  return (parsed && readJsonObject(parsed.json)) ?? {};
}

export function rpcJsonResponse(output: unknown, status = 200): Response {
  return new Response(JSON.stringify({ json: output }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A refused RPC call, in the envelope the link decodes back into an
 * `ORPCError`. `data` is the failure payload the server's adapter put there,
 * which is where a machine-readable `code` travels.
 */
export function rpcErrorResponse(failure: {
  code: string;
  status: number;
  message: string;
  data?: JsonValue;
}): Response {
  return new Response(
    JSON.stringify({
      json: {
        defined: false,
        inferable: false,
        code: failure.code,
        message: failure.message,
        ...(failure.data === undefined ? {} : { data: failure.data }),
      },
    }),
    {
      status: failure.status,
      headers: { "content-type": "application/json" },
    }
  );
}

export function extractRpcProcedurePath(url: string): string {
  const marker = "/api/rpc/";
  const index = url.indexOf(marker);
  if (index === -1) {
    return "";
  }

  return url.slice(index + marker.length).split("?")[0] ?? "";
}

type RawExecution = {
  id: string;
  workflowId: string;
  workflowRunId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  waitingAt: string | null;
  cancelledAt: string | null;
  duration: string | null;
  error: string | null;
  entityValue: string | null;
  startEventName: string | null;
  runMode: string;
  startSource: string;
};

export type WorkflowRunRpcFixture = {
  items: RawExecution[];
  supersededCount: number;
  graphs: Record<string, SerializedWorkflowGraph>;
  logsSummaryExtras: Record<
    string,
    {
      runMode?: string;
      startSource?: string | null;
      startEventName?: string | null;
      entityValue?: string | null;
    }
  >;
  logsByExecutionId: Record<string, unknown[]>;
  waitsByExecutionId: Record<string, unknown[]>;
};

function versionIdFor(executionId: string): string {
  return `ver_${executionId}`;
}

export async function answerWorkflowRunRpc(
  served: WorkflowRunRpcFixture,
  procedurePath: string,
  input: JsonObject
): Promise<Response> {
  switch (procedurePath) {
    case "workflow/getExecutions":
      return rpcJsonResponse({
        items: input.includeSuperseded
          ? served.items
          : served.items.filter((item) => item.status !== "superseded"),
        supersededCount: served.supersededCount,
        refusedStarts: [],
      });

    case "workflow/getExecutionLogs": {
      const executionId =
        typeof input.executionId === "string" ? input.executionId : "";
      const listed = served.items.find((item) => item.id === executionId);
      const extras = served.logsSummaryExtras[executionId] ?? {};
      return rpcJsonResponse({
        execution: {
          id: executionId,
          workflowId: listed?.workflowId ?? "wf_1",
          workflowVersionId: versionIdFor(executionId),
          status: listed?.status ?? "completed",
          startSource: listed?.startSource ?? "event",
          runMode: listed?.runMode ?? "live",
          startEventName: listed?.startEventName ?? null,
          entityValue: listed?.entityValue ?? null,
          error: null,
          startedAt: "2026-03-01T10:00:00.000Z",
          completedAt: "2026-03-01T10:00:30.000Z",
          duration: "30s",
          input: {},
          output: {},
          ...extras,
        },
        logs: served.logsByExecutionId[executionId] ?? [],
        waits: served.waitsByExecutionId[executionId] ?? [],
      });
    }

    case "workflow/getVersionGraph": {
      const versionId =
        typeof input.versionId === "string" ? input.versionId : "";
      return rpcJsonResponse({
        graph:
          served.graphs[versionId] ??
          createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      });
    }

    case "workflow/getExecutionEvents":
      return rpcJsonResponse({ events: [] });

    case "workflow/cancelExecution":
    case "workflow/resumeWait":
    case "workflow/deleteExecutions":
      return rpcJsonResponse({});

    default:
      throw new Error(`unexpected workflow RPC procedure: ${procedurePath}`);
  }
}
