import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { getBasePath } from "@/lib/base-path";
import type { RpcContract } from "@rova/shared/rpc/contracts";
import { getRpcErrorMessage } from "@rova/shared/rpc/error-message";
import type { WorkflowApiPayload } from "@rova/shared/workflow/api-contracts";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@rova/shared/workflow/graph";
import type {
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowMode,
  WorkflowNode,
  WorkflowVisibility,
} from "@rova/shared/workflow/types";

export type { WorkflowVisibility } from "@rova/shared/workflow/types";

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
};

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

const link = new RPCLink({
  url: resolveRpcUrl(),
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
            error.status,
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

export const rpc: ContractRouterClient<RpcContract> = createORPCClient(link);

type RpcOutput<T> = T extends (...args: never[]) => Promise<infer TResult>
  ? TResult
  : never;
export type WorkflowExecuteResult = RpcOutput<typeof rpc.workflow.execute>;
export type WorkflowExecutionsGlobalResult = RpcOutput<
  typeof rpc.workflow.getExecutionsGlobal
>;

export function toSavedWorkflow(payload: WorkflowApiPayload): SavedWorkflow {
  const graphData = toWorkflowGraphData(payload.graph);

  return {
    ...payload,
    nodes: graphData.nodes,
    edges: graphData.edges,
  };
}

export function toSavedWorkflows(
  payload: WorkflowApiPayload[]
): SavedWorkflow[] {
  return payload.map(toSavedWorkflow);
}

function toGraphPayload(input: {
  graph?: SerializedWorkflowGraph;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
}): SerializedWorkflowGraph {
  if (input.graph) {
    return input.graph;
  }

  return createSerializedWorkflowGraph({
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
        description: workflow.description,
        graph: toGraphPayload(workflow),
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

    return rpc.workflow
      .update({
        workflowId: id,
        name: workflow.name,
        description: workflow.description,
        graph,
        mode: workflow.mode,
      })
      .then(toSavedWorkflow);
  },
};
