import type { SerializedWorkflowGraph, WorkflowVisibility } from "./types";

export type ApiErrorPayload = {
  error: string;
  message?: string;
  details?: string;
};

export type WorkflowApiPayload = {
  id?: string;
  name?: string;
  description?: string;
  graph: SerializedWorkflowGraph;
  visibility?: WorkflowVisibility;
  createdAt?: string;
  updatedAt?: string;
  isOwner?: boolean;
};
