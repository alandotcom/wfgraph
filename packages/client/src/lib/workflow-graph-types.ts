/**
 * Editor view-model for the workflow graph.
 *
 * Persisted shapes live in `@wfgraph/shared/graph/types`. React Flow's `Node` /
 * `Edge` and run `status` are editor-only and stop at this package.
 */

import type { Edge, Node } from "@xyflow/react";
import type {
  NodeRunStatus,
  PersistedNodeData,
  WorkflowNode as PersistedWorkflowNode,
  WorkflowEdge as PersistedWorkflowEdge,
} from "@wfgraph/shared/graph/types";

export type { NodeRunStatus, PersistedNodeData };
export type {
  ExecutionLogEntry,
  WorkflowMode,
  WorkflowNodeType,
  WorkflowVisibility,
} from "@wfgraph/shared/graph/types";

export type EditorNodeData = PersistedNodeData & {
  status?: NodeRunStatus;
};

/** Display-only fields painted onto edges; never part of the draft save path. */
export type EditorEdgeData = Record<string, unknown> & {
  displayLabel?: string;
};

export type WorkflowNodeData = EditorNodeData;
export type WorkflowNode = Node<EditorNodeData>;
export type WorkflowEdge = Edge<EditorEdgeData>;

/** Strip editor-only fields before a node crosses into the persist path. */
export function toPersistedNode(node: WorkflowNode): PersistedWorkflowNode {
  const { status: _status, ...data } = node.data;
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
  if (typeof node.parentId === "string" && node.parentId.length > 0) {
    persisted.parentId = node.parentId;
  }
  return persisted;
}

export function toPersistedEdge(edge: WorkflowEdge): PersistedWorkflowEdge {
  const { displayLabel: _displayLabel, ...rest } = edge.data ?? {};
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    data: Object.keys(rest).length > 0 ? rest : undefined,
    type: edge.type,
    selected: edge.selected,
  };
}

export function toEditorNode(node: PersistedWorkflowNode): WorkflowNode {
  const editor: WorkflowNode = {
    id: node.id,
    position: node.position,
    type: node.type,
    selected: node.selected,
    dragging: node.dragging,
    width: node.width,
    height: node.height,
    measured: node.measured,
    // No status: a freshly converted node carries no run of its own. The
    // graph store merges a run's status onto whichever graph is on screen at
    // display time, so this node's `data` never needs one baked in.
    data: { ...node.data },
  };
  if (node.parentId) {
    editor.parentId = node.parentId;
    editor.extent = "parent";
    editor.draggable = false;
    editor.connectable = false;
  }
  return editor;
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
