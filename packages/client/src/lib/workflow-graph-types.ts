/**
 * Editor view-model for the workflow graph.
 *
 * Persisted shapes live in `@rova/shared/graph/types`. React Flow's `Node` /
 * `Edge` and run `status` are editor-only and stop at this package.
 */

import type { Edge, Node } from "@xyflow/react";
import type {
  NodeRunStatus,
  PersistedNodeData,
  WorkflowNode as PersistedWorkflowNode,
  WorkflowEdge as PersistedWorkflowEdge,
} from "@rova/shared/graph/types";

export type { NodeRunStatus, PersistedNodeData };
export type {
  ExecutionLogEntry,
  WorkflowMode,
  WorkflowNodeType,
  WorkflowVisibility,
} from "@rova/shared/graph/types";

export type EditorNodeData = PersistedNodeData & {
  status?: NodeRunStatus;
  /**
   * Display-only: the node sits behind Canceled with no Cancel Event declared.
   * Never persisted; derived onto `displayNodesAtom` only.
   */
  inactiveCanceled?: boolean;
};

export type WorkflowNodeData = EditorNodeData;
export type WorkflowNode = Node<EditorNodeData>;
export type WorkflowEdge = Edge;

/** Strip editor-only fields before a node crosses into the persist path. */
export function toPersistedNode(node: WorkflowNode): PersistedWorkflowNode {
  const {
    status: _status,
    inactiveCanceled: _inactiveCanceled,
    ...data
  } = node.data;
  const persisted: PersistedWorkflowNode = {
    id: node.id,
    position: node.position,
    data,
    type: node.type,
    selected: node.selected,
    dragging: node.dragging,
  };
  if (typeof node.width === "number") {
    persisted.width = node.width;
  }
  if (typeof node.height === "number") {
    persisted.height = node.height;
  }
  if (
    node.measured &&
    typeof node.measured.width === "number" &&
    typeof node.measured.height === "number"
  ) {
    persisted.measured = {
      width: node.measured.width,
      height: node.measured.height,
    };
  }
  return persisted;
}

export function toPersistedEdge(edge: WorkflowEdge): PersistedWorkflowEdge {
  let data: Record<string, unknown> | undefined;
  if (
    typeof edge.data === "object" &&
    edge.data !== null &&
    !Array.isArray(edge.data)
  ) {
    const { inactiveCanceled: _inactiveCanceled, ...rest } = edge.data as {
      inactiveCanceled?: unknown;
      [key: string]: unknown;
    };
    data = Object.keys(rest).length > 0 ? rest : undefined;
  }

  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    data,
    type: edge.type,
    selected: edge.selected,
  };
}

export function toEditorNode(node: PersistedWorkflowNode): WorkflowNode {
  return {
    id: node.id,
    position: node.position,
    type: node.type,
    selected: node.selected,
    dragging: node.dragging,
    width: node.width,
    height: node.height,
    measured: node.measured,
    data: { ...node.data, status: "idle" },
  };
}

export function toEditorEdge(edge: PersistedWorkflowEdge): WorkflowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    data: edge.data,
    type: edge.type,
    selected: edge.selected,
  };
}
