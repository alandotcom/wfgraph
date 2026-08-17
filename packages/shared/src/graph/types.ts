import type { SerializedWorkflowGraphInput } from "#src/graph/schemas";

export type WorkflowNodeType = "lifecycle" | "action" | "add" | "group";
export type ConditionBranch = "true" | "false";

/** Run overlay status. Lives on the editor view-model, never on the wire. */
export type NodeRunStatus =
  | "idle"
  | "running"
  | "success"
  | "error"
  | "cancelled";

/**
 * What a node carries in the JSONB column, RPC payloads, and the engine.
 *
 * No `status` (run overlay) and no `onClick` (editor chrome). Those belong on
 * the client view-model built from this shape.
 */
export type PersistedNodeData = {
  label: string;
  description?: string;
  type: WorkflowNodeType;
  config?: Record<string, unknown>;
  enabled?: boolean;
};

/**
 * A graph node without React Flow. Positions and ids are required after decode;
 * bookkeeping fields the editor round-trips stay optional.
 */
export type WorkflowNode = {
  id: string;
  position: { x: number; y: number };
  data: PersistedNodeData;
  /** React Flow types this as `string`; persisted values are WorkflowNodeType. */
  type?: string;
  selected?: boolean;
  dragging?: boolean;
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
  /**
   * Editor nesting: the Group frame this node sits inside. The engine walks
   * children and never schedules the frame. React Flow's `extent` stays on the
   * editor view-model; it is wider than `"parent"` and must not land here.
   */
  parentId?: string;
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data?: Record<string, unknown>;
  selected?: boolean;
};

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
