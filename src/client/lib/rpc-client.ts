import { type ClientResponse, hc, type InferResponseType } from "hono/client";
import type { AppType } from "@/backend/app";
import type {
  IntegrationConfig,
  IntegrationType,
} from "@/shared/types/integration";
import type {
  WorkflowExecuteResponse,
  WorkflowWebhookResponse,
} from "@/shared/workflow/execution-contracts";
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

// Workflow data types
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

// API error class
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export const rpc = hc<AppType>("");

type RpcResponse = ClientResponse<unknown, number, string>;

function getErrorMessage(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "Request failed";
  }

  const maybeError = payload as { error?: unknown; message?: unknown };
  if (typeof maybeError.error === "string" && maybeError.error.length > 0) {
    return maybeError.error;
  }

  if (typeof maybeError.message === "string" && maybeError.message.length > 0) {
    return maybeError.message;
  }

  return "Request failed";
}

async function rpcCall<
  TMethod extends (...args: never[]) => Promise<RpcResponse>,
  TData = InferResponseType<TMethod, 200>,
>(method: TMethod, ...args: Parameters<TMethod>): Promise<TData> {
  const response = await method(...args);

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as unknown;
    throw new ApiError(response.status, getErrorMessage(errorPayload));
  }

  return response.json() as Promise<TData>;
}

type WorkflowApiPayload = InferResponseType<
  (typeof rpc.api.workflows)[":workflowId"]["$get"],
  200
>;

type WorkflowsApiPayload = InferResponseType<
  (typeof rpc.api.workflows)["$get"],
  200
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

function toSavedWorkflows(payload: WorkflowsApiPayload): SavedWorkflow[] {
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

export type Integration = {
  id: string;
  name: string;
  type: IntegrationType;
  isManaged?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type IntegrationWithConfig = Integration & {
  config: IntegrationConfig;
};

// Integration API
export const integrationApi = {
  // List all integrations
  getAll: (type?: IntegrationType): Promise<Integration[]> =>
    rpcCall(rpc.api.integrations.$get, { query: type ? { type } : {} }),

  // Get single integration with config
  get: (id: string): Promise<IntegrationWithConfig> =>
    rpcCall(rpc.api.integrations[":integrationId"].$get, {
      param: { integrationId: id },
    }),

  // Create integration
  create: (data: {
    name: string;
    type: IntegrationType;
    config: IntegrationConfig;
  }): Promise<Integration> =>
    rpcCall(rpc.api.integrations.$post, {
      json: data,
    }),

  // Update integration
  update: (
    id: string,
    data: { name?: string; config?: IntegrationConfig }
  ): Promise<IntegrationWithConfig> => {
    const request = {
      param: { integrationId: id },
      json: data,
    };

    return rpcCall(rpc.api.integrations[":integrationId"].$put, request);
  },

  // Delete integration
  delete: (id: string): Promise<{ success: boolean }> =>
    rpcCall(rpc.api.integrations[":integrationId"].$delete, {
      param: { integrationId: id },
    }),

  // Test existing integration connection
  testConnection: (
    integrationId: string
  ): Promise<{ status: "success" | "error"; message: string }> =>
    rpcCall(rpc.api.integrations[":integrationId"].test.$post, {
      param: { integrationId },
    }),

  // Test credentials without saving
  testCredentials: (data: {
    type: IntegrationType;
    config: IntegrationConfig;
  }): Promise<{ status: "success" | "error"; message: string }> =>
    rpcCall(rpc.api.integrations.test.$post, {
      json: data,
    }),
};

// Workflow API
export const workflowApi = {
  // Get all workflows
  getAll: (): Promise<SavedWorkflow[]> =>
    rpcCall(rpc.api.workflows.$get).then(toSavedWorkflows),

  // Get a specific workflow
  getById: (id: string): Promise<SavedWorkflow> =>
    rpcCall(rpc.api.workflows[":workflowId"].$get, {
      param: { workflowId: id },
    }).then(toSavedWorkflow),

  // Create a new workflow
  create: (workflow: {
    name: string;
    description?: string;
    graph?: SerializedWorkflowGraph;
    nodes?: WorkflowNode[];
    edges?: WorkflowEdge[];
  }): Promise<SavedWorkflow> =>
    rpcCall(rpc.api.workflows.create.$post, {
      json: {
        name: workflow.name,
        description: workflow.description,
        graph: toGraphPayload(workflow),
      },
    }).then(toSavedWorkflow),

  // Update a workflow
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

    const request = {
      param: { workflowId: id },
      json: {
        name: workflow.name,
        description: workflow.description,
        graph,
      },
    };

    return rpcCall(rpc.api.workflows[":workflowId"].$patch, request).then(
      toSavedWorkflow
    );
  },

  // Delete a workflow
  delete: (id: string): Promise<{ success: boolean }> =>
    rpcCall(rpc.api.workflows[":workflowId"].$delete, {
      param: { workflowId: id },
    }),

  // Duplicate a workflow
  duplicate: (id: string): Promise<SavedWorkflow> =>
    rpcCall(rpc.api.workflows[":workflowId"].duplicate.$post, {
      param: { workflowId: id },
    }).then(toSavedWorkflow),

  // Get current workflow state
  getCurrent: (): Promise<WorkflowData> =>
    rpcCall(rpc.api.workflows.current.$get).then(toWorkflowData),

  // Save current workflow state
  saveCurrent: (input: {
    graph?: SerializedWorkflowGraph;
    nodes?: WorkflowNode[];
    edges?: WorkflowEdge[];
  }): Promise<WorkflowData> =>
    rpcCall(rpc.api.workflows.current.$post, {
      json: {
        graph: toGraphPayload(input),
      },
    }).then(toWorkflowData),

  // Execute workflow
  execute: (
    id: string,
    input: Record<string, unknown> = {},
    options?: { dryRun?: boolean }
  ): Promise<WorkflowExecuteResponse> => {
    const request = {
      param: { workflowId: id },
      json: { input, dryRun: options?.dryRun === true },
    };

    return rpcCall(rpc.api.workflow[":workflowId"].execute.$post, request);
  },

  // Trigger workflow via webhook
  triggerWebhook: (
    id: string,
    input: Record<string, unknown> = {},
    options?: { dryRun?: boolean }
  ): Promise<WorkflowWebhookResponse> => {
    if (options?.dryRun) {
      const request = {
        param: { workflowId: id },
        query: { dryRun: "true" as const },
        json: input,
      };

      return rpcCall(rpc.api.workflows[":workflowId"].webhook.$post, request);
    }

    const request = {
      param: { workflowId: id },
      query: {},
      json: input,
    };

    return rpcCall(rpc.api.workflows[":workflowId"].webhook.$post, request);
  },

  // Get executions
  getExecutions: (
    id: string
  ): Promise<
    Array<{
      id: string;
      workflowId: string;
      status:
        | "pending"
        | "running"
        | "waiting"
        | "success"
        | "error"
        | "cancelled";
      triggerType: "manual" | "webhook" | null;
      isDryRun: boolean;
      triggerEventType: string | null;
      correlationKey: string | null;
      workflowRunId: string | null;
      input: unknown;
      output: unknown;
      error: string | null;
      startedAt: string;
      waitingAt: string | null;
      cancelledAt: string | null;
      completedAt: string | null;
      duration: string | null;
    }>
  > =>
    rpcCall(rpc.api.workflows[":workflowId"].executions.$get, {
      param: { workflowId: id },
    }),

  // Delete executions
  deleteExecutions: (
    id: string
  ): Promise<{ success: boolean; deletedCount: number }> =>
    rpcCall(rpc.api.workflows[":workflowId"].executions.$delete, {
      param: { workflowId: id },
    }),

  // Get execution logs
  getExecutionLogs: (
    executionId: string
  ): Promise<{
    execution: {
      id: string;
      workflowId: string;
      status: string;
      input: unknown;
      output: unknown;
      error: string | null;
      startedAt: string;
      completedAt: string | null;
      duration: string | null;
    };
    logs: Array<{
      id: string;
      executionId: string;
      nodeId: string;
      nodeName: string;
      nodeType: string;
      status: "pending" | "running" | "success" | "error";
      input: unknown;
      output: unknown;
      error: string | null;
      startedAt: string;
      completedAt: string | null;
      duration: string | null;
    }>;
  }> =>
    rpcCall(rpc.api.workflows.executions[":executionId"].logs.$get, {
      param: { executionId },
    }),

  // Get execution audit events
  getExecutionEvents: (
    executionId: string
  ): Promise<{
    events: Array<{
      id: string;
      workflowId: string;
      executionId: string | null;
      eventType: string;
      message: string;
      metadata: unknown;
      createdAt: string;
    }>;
  }> =>
    rpcCall(rpc.api.workflows.executions[":executionId"].events.$get, {
      param: { executionId },
    }),

  // Cancel execution (only while waiting)
  cancelExecution: (
    executionId: string
  ): Promise<{
    success: boolean;
    status: "cancelled";
    cancelledWaitStates: number;
  }> =>
    rpcCall(rpc.api.workflows.executions[":executionId"].cancel.$post, {
      param: { executionId },
    }),

  // Get execution status
  getExecutionStatus: (
    executionId: string
  ): Promise<{
    status: string;
    nodeStatuses: Array<{
      nodeId: string;
      status: "pending" | "running" | "success" | "error" | "cancelled";
    }>;
  }> =>
    rpcCall(rpc.api.workflows.executions[":executionId"].status.$get, {
      param: { executionId },
    }),

  // Auto-save specific workflow with debouncing
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

// Export all APIs as a single object
export const api = {
  integration: integrationApi,
  workflow: workflowApi,
};
