import type {
  SerializedWorkflowGraph,
  WorkflowMode,
  WorkflowVisibility,
} from "./types";

export type WorkflowApiPayload = {
  id: string;
  name: string;
  description?: string;
  graph: SerializedWorkflowGraph;
  isPaused: boolean;
  mode: WorkflowMode;
  visibility: WorkflowVisibility;
  createdAt: string;
  updatedAt: string;
  /** Absent on a payload the viewer did not author. */
  isOwner?: boolean;
};
