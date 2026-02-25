import type {
  SerializedWorkflowGraph,
  WorkflowMode,
  WorkflowVisibility,
} from "./types";

export type ApiErrorPayload = {
  error: string;
  code?: string;
  invalidIntegrationIds?: string[];
  message?: string;
  details?: string;
};

export type WorkflowApiPayload = {
  id?: string;
  name?: string;
  description?: string;
  graph: SerializedWorkflowGraph;
  isPaused?: boolean;
  mode?: WorkflowMode;
  visibility?: WorkflowVisibility;
  createdAt?: string;
  updatedAt?: string;
  isOwner?: boolean;
};
