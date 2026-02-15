import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { RpcContract } from "@/shared/rpc/contracts";
import { getRpcErrorMessage } from "@/shared/rpc/error-message";
import type { WorkflowApiPayload } from "@/shared/workflow/api-contracts";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@/shared/workflow/graph";
import type {
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
  WorkflowVisibility,
} from "@/shared/workflow/types";

export type { WorkflowVisibility } from "@/shared/workflow/types";

export type WorkflowData = {
  id?: string;
  name?: string;
  description?: string;
  graph: SerializedWorkflowGraph;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  visibility?: WorkflowVisibility;
};

export type SavedWorkflow = WorkflowData & {
  id: string;
  name: string;
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

const link = new RPCLink({
  url: "/api/rpc",
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
type WorkflowExecuteResult = RpcOutput<typeof rpc.workflow.execute>;
type WorkflowWebhookResult = RpcOutput<typeof rpc.workflow.triggerWebhook>;
type WorkflowExecutionsResult = RpcOutput<typeof rpc.workflow.getExecutions>;
type WorkflowDeleteExecutionsResult = RpcOutput<
  typeof rpc.workflow.deleteExecutions
>;
type WorkflowExecutionLogsResult = RpcOutput<
  typeof rpc.workflow.getExecutionLogs
>;
type WorkflowExecutionEventsResult = RpcOutput<
  typeof rpc.workflow.getExecutionEvents
>;
type WorkflowCancelExecutionResult = RpcOutput<
  typeof rpc.workflow.cancelExecution
>;
type WorkflowExecutionStatusResult = RpcOutput<
  typeof rpc.workflow.getExecutionStatus
>;

function toWorkflowData(payload: WorkflowApiPayload): WorkflowData {
  const graphData = toWorkflowGraphData(payload.graph);

  return {
    ...payload,
    graph: payload.graph,
    nodes: graphData.nodes,
    edges: graphData.edges,
  };
}

function toSavedWorkflow(payload: WorkflowApiPayload): SavedWorkflow {
  const graphData = toWorkflowGraphData(payload.graph);

  return {
    id: payload.id ?? "",
    name: payload.name ?? "",
    description: payload.description,
    graph: payload.graph,
    nodes: graphData.nodes,
    edges: graphData.edges,
    visibility: payload.visibility ?? "private",
    createdAt: payload.createdAt ?? new Date(0).toISOString(),
    updatedAt: payload.updatedAt ?? new Date(0).toISOString(),
    isOwner: payload.isOwner,
  };
}

function toSavedWorkflows(payload: WorkflowApiPayload[]): SavedWorkflow[] {
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
export type IntegrationWithConfig = RpcOutput<typeof rpc.integration.get>;
export type ApiKey = RpcOutput<typeof rpc.apiKey.getAll>[number] & {
  key?: string;
};

export const workflowApi = {
  getAll: (): Promise<SavedWorkflow[]> =>
    rpc.workflow.getAll({}).then(toSavedWorkflows),

  getById: (id: string): Promise<SavedWorkflow> =>
    rpc.workflow.getById({ workflowId: id }).then(toSavedWorkflow),

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
      })
      .then(toSavedWorkflow);
  },

  delete: (id: string): Promise<{ success: true }> =>
    rpc.workflow.delete({ workflowId: id }),

  duplicate: (id: string): Promise<SavedWorkflow> =>
    rpc.workflow.duplicate({ workflowId: id }).then(toSavedWorkflow),

  getCurrent: (): Promise<WorkflowData> =>
    rpc.workflow.getCurrent({}).then(toWorkflowData),

  saveCurrent: (input: {
    graph?: SerializedWorkflowGraph;
    nodes?: WorkflowNode[];
    edges?: WorkflowEdge[];
  }): Promise<WorkflowData> =>
    rpc.workflow
      .saveCurrent({
        graph: toGraphPayload(input),
      })
      .then(toWorkflowData),

  execute: (
    id: string,
    input: Record<string, unknown> = {},
    options?: { dryRun?: boolean }
  ): Promise<WorkflowExecuteResult> =>
    rpc.workflow.execute({
      workflowId: id,
      input,
      dryRun: options?.dryRun === true,
    }),

  triggerWebhook: (
    id: string,
    input: Record<string, unknown> = {},
    options?: { dryRun?: boolean }
  ): Promise<WorkflowWebhookResult> =>
    rpc.workflow.triggerWebhook({
      workflowId: id,
      input,
      dryRun: options?.dryRun,
    }),

  getExecutions: (id: string): Promise<WorkflowExecutionsResult> =>
    rpc.workflow.getExecutions({ workflowId: id }),

  deleteExecutions: (id: string): Promise<WorkflowDeleteExecutionsResult> =>
    rpc.workflow.deleteExecutions({ workflowId: id }),

  getExecutionLogs: (
    executionId: string
  ): Promise<WorkflowExecutionLogsResult> =>
    rpc.workflow.getExecutionLogs({ executionId }),

  getExecutionEvents: (
    executionId: string
  ): Promise<WorkflowExecutionEventsResult> =>
    rpc.workflow.getExecutionEvents({ executionId }),

  cancelExecution: (
    executionId: string
  ): Promise<WorkflowCancelExecutionResult> =>
    rpc.workflow.cancelExecution({ executionId }),

  getExecutionStatus: (
    executionId: string
  ): Promise<WorkflowExecutionStatusResult> =>
    rpc.workflow.getExecutionStatus({ executionId }),

  autoSaveWorkflow: (() => {
    let autosaveTimeout: ReturnType<typeof setTimeout> | null = null;
    const AUTOSAVE_DELAY = 2000;

    return (
      id: string,
      data: Partial<WorkflowData>,
      debounce = true
    ): Promise<SavedWorkflow> | undefined => {
      if (!debounce) {
        return workflowApi.update(id, data);
      }

      if (autosaveTimeout) {
        clearTimeout(autosaveTimeout);
      }

      autosaveTimeout = setTimeout(() => {
        workflowApi.update(id, data).catch((error) => {
          console.error("[rpc-client] Auto-save workflow update failed", {
            workflowId: id,
            error,
          });
        });
      }, AUTOSAVE_DELAY);
    };
  })(),
};

export const api = {
  apiKey: rpc.apiKey,
  integration: rpc.integration,
  workflow: workflowApi,
};
