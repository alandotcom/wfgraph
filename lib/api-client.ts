/**
 * API Client for making type-safe API calls to the backend
 * Replaces server actions with API endpoints
 */

import type { IntegrationConfig, IntegrationType } from "./types/integration";
import type { WorkflowEdge, WorkflowNode } from "./workflow-store";

// Workflow data types
export type WorkflowVisibility = "private" | "public";

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

// Helper function to make API calls
async function apiCall<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(endpoint, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Unknown error" }));
    throw new ApiError(response.status, error.error || "Request failed");
  }

  return response.json();
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
  getAll: (type?: IntegrationType) =>
    apiCall<Integration[]>(`/api/integrations${type ? `?type=${type}` : ""}`),

  // Get single integration with config
  get: (id: string) =>
    apiCall<IntegrationWithConfig>(`/api/integrations/${id}`),

  // Create integration
  create: (data: {
    name: string;
    type: IntegrationType;
    config: IntegrationConfig;
  }) =>
    apiCall<Integration>("/api/integrations", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Update integration
  update: (id: string, data: { name?: string; config?: IntegrationConfig }) =>
    apiCall<IntegrationWithConfig>(`/api/integrations/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // Delete integration
  delete: (id: string) =>
    apiCall<{ success: boolean }>(`/api/integrations/${id}`, {
      method: "DELETE",
    }),

  // Test existing integration connection
  testConnection: (integrationId: string) =>
    apiCall<{ status: "success" | "error"; message: string }>(
      `/api/integrations/${integrationId}/test`,
      {
        method: "POST",
      }
    ),

  // Test credentials without saving
  testCredentials: (data: {
    type: IntegrationType;
    config: IntegrationConfig;
  }) =>
    apiCall<{ status: "success" | "error"; message: string }>(
      "/api/integrations/test",
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    ),
};

// User API
export const userApi = {
  get: () =>
    apiCall<{
      id: string;
      name: string | null;
      email: string;
      image: string | null;
      isAnonymous: boolean | null;
      providerId: string | null;
    }>("/api/user"),

  update: (data: { name?: string; email?: string }) =>
    apiCall<{ success: boolean }>("/api/user", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
};

// Workflow API
export const workflowApi = {
  // Get all workflows
  getAll: () => apiCall<SavedWorkflow[]>("/api/workflows"),

  // Get a specific workflow
  getById: (id: string) => apiCall<SavedWorkflow>(`/api/workflows/${id}`),

  // Create a new workflow
  create: (workflow: Omit<WorkflowData, "id">) =>
    apiCall<SavedWorkflow>("/api/workflows/create", {
      method: "POST",
      body: JSON.stringify(workflow),
    }),

  // Update a workflow
  update: (id: string, workflow: Partial<WorkflowData>) =>
    apiCall<SavedWorkflow>(`/api/workflows/${id}`, {
      method: "PATCH",
      body: JSON.stringify(workflow),
    }),

  // Delete a workflow
  delete: (id: string) =>
    apiCall<{ success: boolean }>(`/api/workflows/${id}`, {
      method: "DELETE",
    }),

  // Duplicate a workflow
  duplicate: (id: string) =>
    apiCall<SavedWorkflow>(`/api/workflows/${id}/duplicate`, {
      method: "POST",
    }),

  // Get current workflow state
  getCurrent: () => apiCall<WorkflowData>("/api/workflows/current"),

  // Save current workflow state
  saveCurrent: (nodes: WorkflowNode[], edges: WorkflowEdge[]) =>
    apiCall<WorkflowData>("/api/workflows/current", {
      method: "POST",
      body: JSON.stringify({ nodes, edges }),
    }),

  // Execute workflow
  execute: (
    id: string,
    input: Record<string, unknown> = {},
    options?: { dryRun?: boolean }
  ) =>
    apiCall<{
      executionId: string;
      runId?: string;
      status: string;
      dryRun?: boolean;
      output?: unknown;
      error?: string;
      duration?: number;
    }>(`/api/workflow/${id}/execute`, {
      method: "POST",
      body: JSON.stringify({ input, dryRun: options?.dryRun === true }),
    }),

  // Trigger workflow via webhook
  triggerWebhook: (
    id: string,
    input: Record<string, unknown> = {},
    options?: { dryRun?: boolean }
  ) =>
    apiCall<{
      executionId?: string;
      runId?: string;
      status: string;
      dryRun?: boolean;
      resumedCount?: number;
      cancelledExecutions?: number;
      reason?: string;
    }>(`/api/workflows/${id}/webhook${options?.dryRun ? "?dryRun=true" : ""}`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // Get executions
  getExecutions: (id: string) =>
    apiCall<
      Array<{
        id: string;
        workflowId: string;
        userId: string;
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
    >(`/api/workflows/${id}/executions`),

  // Delete executions
  deleteExecutions: (id: string) =>
    apiCall<{ success: boolean; deletedCount: number }>(
      `/api/workflows/${id}/executions`,
      {
        method: "DELETE",
      }
    ),

  // Get execution logs
  getExecutionLogs: (executionId: string) =>
    apiCall<{
      execution: {
        id: string;
        workflowId: string;
        userId: string;
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
    }>(`/api/workflows/executions/${executionId}/logs`),

  // Get execution audit events
  getExecutionEvents: (executionId: string) =>
    apiCall<{
      events: Array<{
        id: string;
        workflowId: string;
        executionId: string | null;
        userId: string;
        eventType: string;
        message: string;
        metadata: unknown;
        createdAt: Date;
      }>;
    }>(`/api/workflows/executions/${executionId}/events`),

  // Cancel execution (only while waiting)
  cancelExecution: (executionId: string) =>
    apiCall<{
      success: boolean;
      status: "cancelled";
      cancelledWaitStates: number;
    }>(`/api/workflows/executions/${executionId}/cancel`, {
      method: "POST",
    }),

  // Get execution status
  getExecutionStatus: (executionId: string) =>
    apiCall<{
      status: string;
      nodeStatuses: Array<{
        nodeId: string;
        status: "pending" | "running" | "success" | "error" | "cancelled";
      }>;
    }>(`/api/workflows/executions/${executionId}/status`),

  // Auto-save with debouncing (kept for backwards compatibility)
  autoSaveCurrent: (() => {
    let autosaveTimeout: NodeJS.Timeout | null = null;
    const AUTOSAVE_DELAY = 2000;

    return (nodes: WorkflowNode[], edges: WorkflowEdge[]): void => {
      if (autosaveTimeout) {
        clearTimeout(autosaveTimeout);
      }

      autosaveTimeout = setTimeout(() => {
        workflowApi.saveCurrent(nodes, edges).catch((error) => {
          console.error("Auto-save failed:", error);
        });
      }, AUTOSAVE_DELAY);
    };
  })(),

  // Auto-save specific workflow with debouncing
  autoSaveWorkflow: (() => {
    let autosaveTimeout: NodeJS.Timeout | null = null;
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
          console.error("Auto-save failed:", error);
        });
      }, AUTOSAVE_DELAY);
    };
  })(),
};

// Export all APIs as a single object
export const api = {
  integration: integrationApi,
  user: userApi,
  workflow: workflowApi,
};
