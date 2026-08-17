import {
  COMMON_ERROR_STATUS_MAP,
  createORPCClient,
  ORPCError,
} from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";
import { isNil } from "es-toolkit/predicate";
import { omitBy } from "es-toolkit/object";
import { getBasePath } from "#src/lib/base-path";
import type { RpcContract } from "@wfgraph/shared/rpc/contracts";
import { getRpcErrorMessage } from "@wfgraph/shared/rpc/error-message";
import type { WorkflowApiPayload } from "@wfgraph/shared/graph/api-contracts";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import type {
  WorkflowEdge,
  WorkflowMode,
  WorkflowNode,
  WorkflowVisibility,
} from "#src/lib/workflow-graph-types";
import {
  toEditorEdge,
  toEditorNode,
  toPersistedEdge,
  toPersistedNodes,
} from "#src/lib/workflow-graph-types";

export type { WorkflowVisibility } from "#src/lib/workflow-graph-types";

export type WorkflowData = {
  id?: string;
  name?: string;
  description?: string;
  graph: SerializedWorkflowGraph;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  isPaused?: boolean;
  mode?: WorkflowMode;
  visibility?: WorkflowVisibility;
};

export type SavedWorkflow = WorkflowData & {
  id: string;
  name: string;
  isPaused: boolean;
  mode: WorkflowMode;
  visibility: WorkflowVisibility;
  createdAt: string;
  updatedAt: string;
  isOwner?: boolean;
  /** Absent until the first publish. */
  publishedVersionId?: string;
  /** Whether the draft graph differs from the published version. */
  hasUnpublishedChanges: boolean;
};

/** Assemble a wire graph from editor nodes/edges, dropping the `add` placeholder. */
export function toSerializedGraph(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): SerializedWorkflowGraph {
  return createSerializedWorkflowGraph({
    nodes: toPersistedNodes(input.nodes),
    edges: input.edges.map(toPersistedEdge),
  });
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

const DEFAULT_RPC_SUFFIX = "/api/rpc";
const DEFAULT_RPC_ORIGIN = "http://localhost:3000";

type ResolveRpcUrlOptions = {
  rpcUrl?: string | null;
  origin?: string | null;
};

function getRuntimeOrigin(): string | undefined {
  const origin =
    typeof globalThis.location?.origin === "string"
      ? globalThis.location.origin.trim()
      : "";

  if (!origin || origin === "null") {
    return undefined;
  }

  return origin;
}

function getConfiguredRpcUrl(): string | undefined {
  const env = (
    import.meta as ImportMeta & {
      env?: Record<string, string | undefined>;
    }
  ).env;

  const rpcUrl = env?.VITE_RPC_URL;
  return typeof rpcUrl === "string" ? rpcUrl : undefined;
}

export function resolveRpcUrl(options: ResolveRpcUrlOptions = {}): string {
  const configuredUrl = options.rpcUrl ?? getConfiguredRpcUrl();

  if (configuredUrl) {
    const url = configuredUrl.trim();
    if (url.length > 0) {
      try {
        return new URL(url).toString();
      } catch {
        const origin =
          options.origin?.trim() || getRuntimeOrigin() || DEFAULT_RPC_ORIGIN;
        try {
          return new URL(url, origin).toString();
        } catch {
          return new URL(url, DEFAULT_RPC_ORIGIN).toString();
        }
      }
    }
  }

  const basePath = getBasePath();
  const rpcPath = `${basePath}${DEFAULT_RPC_SUFFIX}`;

  const origin =
    options.origin?.trim() || getRuntimeOrigin() || DEFAULT_RPC_ORIGIN;

  try {
    return new URL(rpcPath, origin).toString();
  } catch {
    return new URL(rpcPath, DEFAULT_RPC_ORIGIN).toString();
  }
}

/**
 * `RPCLink` takes the server's origin and the handler's path prefix as two
 * separate options, so the one absolute URL every caller configures is split here
 * rather than in `resolveRpcUrl`, which stays the single answer to "where is the
 * API".
 */
function splitRpcUrl(absoluteUrl: string): {
  origin: string;
  pathWithQuery: `/${string}`;
} {
  const url = new URL(absoluteUrl);
  // The query string rides along on purpose: RPCLink parses its `url` option
  // and re-appends the query after the procedure path. The template literal
  // re-adds the leading slash `URL.pathname` always has, because the option's
  // type wants a `/`-prefixed literal.
  return {
    origin: url.origin,
    pathWithQuery: `/${url.pathname.slice(1)}${url.search}`,
  };
}

/**
 * oRPC sends an error code rather than an HTTP status, so the status comes back
 * from the same table the server derived it from. `ApiError` is the last place in
 * the client that speaks HTTP.
 *
 * The annotation widens the table's keys to `string`, because `error.code` is
 * a string rather than a union of known codes; an unmapped code indexes to
 * `undefined` and the `?? 500` at the call site absorbs it.
 */
const ORPC_CODE_TO_STATUS: Record<string, number | undefined> =
  COMMON_ERROR_STATUS_MAP;

const rpcEndpoint = splitRpcUrl(resolveRpcUrl());

const link = new RPCLink({
  origin: rpcEndpoint.origin,
  url: rpcEndpoint.pathWithQuery,
  fetch: (url, init) => globalThis.fetch(url, init),
  interceptors: [
    async (options) => {
      try {
        return await options.next();
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }

        if (error instanceof ORPCError) {
          throw new ApiError(
            ORPC_CODE_TO_STATUS[error.code] ?? 500,
            getRpcErrorMessage(error.data ?? error.message)
          );
        }

        if (error instanceof Error) {
          throw new ApiError(500, error.message || "Request failed");
        }

        throw new ApiError(500, "Request failed");
      }
    },
  ],
});

export const rpc: RouterContractClient<RpcContract> = createORPCClient(link);

type RpcOutput<T> = T extends (...args: never[]) => Promise<infer TResult>
  ? TResult
  : never;
export type WorkflowExecuteResult = RpcOutput<typeof rpc.workflow.execute>;
export type WorkflowExecutionsGlobalResult = RpcOutput<
  typeof rpc.workflow.getExecutionsGlobal
>;
export type ExecutionLogsResult = RpcOutput<
  typeof rpc.workflow.getExecutionLogs
>;

export function toSavedWorkflow(payload: WorkflowApiPayload): SavedWorkflow {
  const graphData = toWorkflowGraphData(payload.graph);

  return {
    ...payload,
    nodes: graphData.nodes.map(toEditorNode),
    edges: graphData.edges.map(toEditorEdge),
  };
}

function toGraphPayload(input: {
  graph?: SerializedWorkflowGraph;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
}): SerializedWorkflowGraph {
  if (input.graph) {
    return input.graph;
  }

  return toSerializedGraph({
    nodes: input.nodes ?? [],
    edges: input.edges ?? [],
  });
}

export type Integration = RpcOutput<typeof rpc.integration.create>;

/**
 * Saving a workflow, for the save store.
 *
 * Everything a component writes goes through `orpcQuery`, where the cache
 * consequences of a write live beside the write. These two stay because the
 * autosave queue in `workflow-save-store.ts` runs outside React, and because
 * both reshape their arguments: a graph is assembled from nodes and edges, and
 * the response is deserialised back into a `SavedWorkflow`. The store swaps this
 * object out in its tests, which is the other reason it is one object.
 */
export const workflowApi = {
  create: (workflow: {
    name: string;
    description?: string;
    graph?: SerializedWorkflowGraph;
    nodes?: WorkflowNode[];
    edges?: WorkflowEdge[];
  }): Promise<SavedWorkflow> =>
    rpc.workflow
      .create({
        name: workflow.name,
        graph: toGraphPayload(workflow),
        ...omitBy({ description: workflow.description }, isNil),
      })
      .then(toSavedWorkflow),

  update: (
    id: string,
    workflow: Partial<WorkflowData>
  ): Promise<SavedWorkflow> => {
    const hasGraphUpdate =
      workflow.graph !== undefined ||
      (workflow.nodes !== undefined && workflow.edges !== undefined);
    const graph = hasGraphUpdate
      ? toGraphPayload({
          graph: workflow.graph,
          nodes: workflow.nodes,
          edges: workflow.edges,
        })
      : undefined;

    // A patch says what changed by leaving the rest out. The contract's
    // optional fields are `Schema.optionalKey`, which is an absent key and not
    // a key holding `undefined`, so the payload is built by dropping the
    // absent ones rather than by naming them all and hoping the serialiser
    // strips what it does not need.
    return rpc.workflow
      .update({
        workflowId: id,
        ...omitBy(
          {
            name: workflow.name,
            description: workflow.description,
            graph,
            mode: workflow.mode,
          },
          isNil
        ),
      })
      .then(toSavedWorkflow);
  },
};
