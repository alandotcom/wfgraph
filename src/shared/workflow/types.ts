import type { Edge, Node } from "@xyflow/react";

export type WorkflowNodeType = "trigger" | "action" | "add";

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

export type WorkflowGraphAttributes = Record<string, unknown>;

export type SerializedWorkflowNode = {
  key: string;
  attributes: WorkflowNode;
};

export type SerializedWorkflowEdge = {
  key: string;
  source: string;
  target: string;
  attributes: WorkflowEdge;
  undirected?: false;
};

export type SerializedWorkflowGraph = {
  attributes?: WorkflowGraphAttributes;
  options?: {
    allowSelfLoops?: boolean;
    multi?: boolean;
    type?: "directed" | "undirected" | "mixed";
  };
  nodes: SerializedWorkflowNode[];
  edges: SerializedWorkflowEdge[];
};

export type WorkflowVisibility = "private" | "public";

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
