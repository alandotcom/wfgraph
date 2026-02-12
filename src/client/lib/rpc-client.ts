import { hc } from "hono/client";
import type { AppType } from "@/backend/server/hono-app";
import type {
  IntegrationConfig,
  IntegrationType,
} from "@/shared/types/integration";
import type {
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

async function rpcCall<T>(request: Promise<Response>): Promise<T> {
  const response = await request;

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Unknown error" }))
      .then((data) =>
        typeof data === "object" && data !== null
          ? (data as { error?: string; message?: string })
          : { error: "Unknown error" }
      );

    throw new ApiError(
      response.status,
      error.error || error.message || "Request failed"
    );
  }

  return response.json() as Promise<T>;
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
    rpcCall(rpc.api.integrations.$get({ query: type ? { type } : {} })),

  // Get single integration with config
  get: (id: string): Promise<IntegrationWithConfig> =>
    rpcCall(
      rpc.api.integrations[":integrationId"].$get({
        param: { integrationId: id },
      })
    ),

  // Create integration
  create: (data: {
    name: string;
    type: IntegrationType;
    config: IntegrationConfig;
  }): Promise<Integration> =>
    rpcCall(
      rpc.api.integrations.$post({
        json: data,
      })
    ),

  // Update integration
  update: (
    id: string,
    data: { name?: string; config?: IntegrationConfig }
  ): Promise<IntegrationWithConfig> => {
    const request = {
      param: { integrationId: id },
      json: data,
    };

    return rpcCall(rpc.api.integrations[":integrationId"].$put(request));
  },

  // Delete integration
  delete: (id: string): Promise<{ success: boolean }> =>
    rpcCall(
      rpc.api.integrations[":integrationId"].$delete({
        param: { integrationId: id },
      })
    ),

  // Test existing integration connection
  testConnection: (
    integrationId: string
  ): Promise<{ status: "success" | "error"; message: string }> =>
    rpcCall(
      rpc.api.integrations[":integrationId"].test.$post({
        param: { integrationId },
      })
    ),

  // Test credentials without saving
  testCredentials: (data: {
    type: IntegrationType;
    config: IntegrationConfig;
  }): Promise<{ status: "success" | "error"; message: string }> =>
    rpcCall(
      rpc.api.integrations.test.$post({
        json: data,
      })
    ),
};

// Workflow API
export const workflowApi = {
  // Get all workflows
  getAll: (): Promise<SavedWorkflow[]> => rpcCall(rpc.api.workflows.$get()),

  // Get a specific workflow
  getById: (id: string): Promise<SavedWorkflow> =>
    rpcCall(
      rpc.api.workflows[":workflowId"].$get({
        param: { workflowId: id },
      })
    ),

  // Create a new workflow
  create: (workflow: {
    name: string;
    description?: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
  }): Promise<SavedWorkflow> =>
    rpcCall(
      rpc.api.workflows.create.$post({
        json: workflow,
      })
    ),

  // Update a workflow
  update: (
    id: string,
    workflow: Partial<WorkflowData>
  ): Promise<SavedWorkflow> => {
    const request = {
      param: { workflowId: id },
      json: workflow,
    };

    return rpcCall(rpc.api.workflows[":workflowId"].$patch(request));
  },

  // Delete a workflow
  delete: (id: string): Promise<{ success: boolean }> =>
    rpcCall(
      rpc.api.workflows[":workflowId"].$delete({
        param: { workflowId: id },
      })
    ),

  // Duplicate a workflow
  duplicate: (id: string): Promise<SavedWorkflow> =>
    rpcCall(
      rpc.api.workflows[":workflowId"].duplicate.$post({
        param: { workflowId: id },
      })
    ),

  // Get current workflow state
  getCurrent: (): Promise<WorkflowData> =>
    rpcCall(rpc.api.workflows.current.$get()),

  // Save current workflow state
  saveCurrent: (
    nodes: WorkflowNode[],
    edges: WorkflowEdge[]
  ): Promise<WorkflowData> =>
    rpcCall(
      rpc.api.workflows.current.$post({
        json: { nodes, edges },
      })
    ),

  // Execute workflow
  execute: (
    id: string,
    input: Record<string, unknown> = {},
    options?: { dryRun?: boolean }
  ): Promise<{
    executionId: string;
    runId?: string;
    status: string;
    dryRun?: boolean;
    output?: unknown;
    error?: string;
    duration?: number;
  }> => {
    const request = {
      param: { workflowId: id },
      json: { input, dryRun: options?.dryRun === true },
    };

    return rpcCall(rpc.api.workflow[":workflowId"].execute.$post(request));
  },

  // Trigger workflow via webhook
  triggerWebhook: (
    id: string,
    input: Record<string, unknown> = {},
    options?: { dryRun?: boolean }
  ): Promise<{
    executionId?: string;
    runId?: string;
    status: string;
    dryRun?: boolean;
    resumedCount?: number;
    cancelledExecutions?: number;
    reason?: string;
  }> => {
    if (options?.dryRun) {
      const request = {
        param: { workflowId: id },
        query: { dryRun: "true" as const },
        json: input,
      };

      return rpcCall(rpc.api.workflows[":workflowId"].webhook.$post(request));
    }

    const request = {
      param: { workflowId: id },
      query: {},
      json: input,
    };

    return rpcCall(rpc.api.workflows[":workflowId"].webhook.$post(request));
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
      startedAt: Date;
      waitingAt: Date | null;
      cancelledAt: Date | null;
      completedAt: Date | null;
      duration: string | null;
    }>
  > =>
    rpcCall(
      rpc.api.workflows[":workflowId"].executions.$get({
        param: { workflowId: id },
      })
    ),

  // Delete executions
  deleteExecutions: (
    id: string
  ): Promise<{ success: boolean; deletedCount: number }> =>
    rpcCall(
      rpc.api.workflows[":workflowId"].executions.$delete({
        param: { workflowId: id },
      })
    ),

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
      startedAt: Date;
      completedAt: Date | null;
      duration: string | null;
      workflow: {
        id: string;
        name: string;
        nodes: unknown;
        edges: unknown;
      };
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
      startedAt: Date;
      completedAt: Date | null;
      duration: string | null;
    }>;
  }> =>
    rpcCall(
      rpc.api.workflows.executions[":executionId"].logs.$get({
        param: { executionId },
      })
    ),

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
      createdAt: Date;
    }>;
  }> =>
    rpcCall(
      rpc.api.workflows.executions[":executionId"].events.$get({
        param: { executionId },
      })
    ),

  // Cancel execution (only while waiting)
  cancelExecution: (
    executionId: string
  ): Promise<{
    success: boolean;
    status: "cancelled";
    cancelledWaitStates: number;
  }> =>
    rpcCall(
      rpc.api.workflows.executions[":executionId"].cancel.$post({
        param: { executionId },
      })
    ),

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
    rpcCall(
      rpc.api.workflows.executions[":executionId"].status.$get({
        param: { executionId },
      })
    ),

  // Auto-save with debouncing (kept for backwards compatibility)
  autoSaveCurrent: (() => {
    let autosaveTimeout: ReturnType<typeof setTimeout> | null = null;
    const AUTOSAVE_DELAY = 2000;

    return (nodes: WorkflowNode[], edges: WorkflowEdge[]): void => {
      if (autosaveTimeout) {
        clearTimeout(autosaveTimeout);
      }

      autosaveTimeout = setTimeout(() => {
        workflowApi.saveCurrent(nodes, edges).catch((error) => {
          console.error("[rpc-client] Auto-save current workflow failed", {
            error,
          });
        });
      }, AUTOSAVE_DELAY);
    };
  })(),

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
