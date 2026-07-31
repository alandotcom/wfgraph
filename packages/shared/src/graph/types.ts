import type { Edge, Node } from "@xyflow/react";
import type { SerializedWorkflowGraphInput } from "#src/graph/schemas";

export type WorkflowNodeType = "lifecycle" | "action" | "add";
export type ConditionBranch = "true" | "false";

export type WorkflowNodeData = {
  label: string;
  description?: string;
  type: WorkflowNodeType;
  config?: Record<string, unknown>;
  status?: "idle" | "running" | "success" | "error" | "cancelled";
  enabled?: boolean;
  onClick?: () => void;
};

export type WorkflowNode = Node<WorkflowNodeData>;
export type WorkflowEdge = Edge;

export type SerializedWorkflowGraph = SerializedWorkflowGraphInput;
export type SerializedWorkflowNode = SerializedWorkflowGraph["nodes"][number];
export type SerializedWorkflowEdge = SerializedWorkflowGraph["edges"][number];

export type WorkflowVisibility = "private" | "public";
export type WorkflowMode = "live" | "test";

export type ExecutionLogEntry = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  input?: unknown;
  output?: unknown;
  startedAt?: Date | string;
  completedAt?: Date | string | null;
};
