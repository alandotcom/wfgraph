/**
 * Editor view-model for the workflow graph.
 *
 * Persisted shapes live in `@wfgraph/shared/graph/types`. React Flow's `Node` /
 * `Edge` and run `status` are editor-only and stop at this package.
 */

import type { Edge, Node } from "@xyflow/react";
import { isEmptyObject } from "es-toolkit/predicate";
import type {
  NodeRunStatus,
  PersistedNodeData,
  WorkflowNode as PersistedWorkflowNode,
  WorkflowEdge as PersistedWorkflowEdge,
} from "@wfgraph/shared/graph/types";
import {
  findAction,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

export type { NodeRunStatus, PersistedNodeData };
export type {
  ExecutionLogEntry,
  WorkflowMode,
  WorkflowNodeType,
  WorkflowVisibility,
} from "@wfgraph/shared/graph/types";

/**
 * What a node's validation badge draws, folded onto the node the same way run
 * status is. Absent when the node is clean, so a clean graph adds nothing to any
 * node's data and the canvas keeps its `React.memo` bail-out.
 */
export type NodeIssueSummary = {
  severity: "blocking" | "warning";
  /** Every issue on this node, for the badge's tooltip and accessible name. */
  messages: string[];
};

/** Structural change metadata that belongs only to a comparison canvas. */
export type ComparisonNodeAnnotation = {
  kind: "added" | "modified" | "removed";
};

/** Display-only identity keeps two semantic edge revisions distinct in React Flow. */
export type ComparisonEdgeAnnotation = {
  kind: "added" | "removed";
  sourceId: string;
};

/** Collision-proof keys for metadata that exists only on the comparison canvas. */
export const COMPARISON_NODE_ANNOTATION: unique symbol = Symbol(
  "wfgraph.comparison.node"
);
export const COMPARISON_EDGE_ANNOTATION: unique symbol = Symbol(
  "wfgraph.comparison.edge"
);

export type EditorNodeData = PersistedNodeData & {
  /** Open persisted node data can legitimately use this string key. */
  comparison?: unknown;
  status?: NodeRunStatus | undefined;
  issues?: NodeIssueSummary | undefined;
  [COMPARISON_NODE_ANNOTATION]?: ComparisonNodeAnnotation | undefined;
};

/** Display-only fields painted onto edges; never part of the draft save path. */
export type EditorEdgeData = Record<string, unknown> & {
  displayLabel?: string | undefined;
  /** Set on an edge landing on a node the run can never reach. */
  inactive?: boolean | undefined;
  [COMPARISON_EDGE_ANNOTATION]?: ComparisonEdgeAnnotation | undefined;
};

export type WorkflowNodeData = EditorNodeData;
export type WorkflowNode = Node<EditorNodeData>;
export type WorkflowEdge = Edge<EditorEdgeData>;

/**
 * The edge component every workflow edge paints with. `workflow-canvas.tsx`
 * registers it under this name and hands it to React Flow as the default for
 * every edge, so no edge here carries a type of its own.
 */
export const WORKFLOW_EDGE_TYPE = "animated";

export function comparisonChangeLabel(
  kind: ComparisonNodeAnnotation["kind"] | ComparisonEdgeAnnotation["kind"]
): string {
  if (kind === "added") {
    return "Added in comparison";
  }
  if (kind === "modified") {
    return "Modified in comparison";
  }
  return "Removed in comparison";
}

/** A comparison names an unavailable action safely rather than exposing its id. */
export function comparisonNodeTitle(
  data: WorkflowNodeData,
  catalog?: ExtensionCatalog
): string {
  const nodeLabel = data.label?.trim();
  if (nodeLabel) {
    return nodeLabel;
  }
  if (data.type === "lifecycle") {
    return "Lifecycle";
  }
  if (data.type === "group") {
    return "Group";
  }
  const actionType = data.config?.actionType;
  const actionLabel =
    typeof actionType === "string" && actionType.trim()
      ? findAction(
          catalog ?? { actions: [], events: [], integrations: [] },
          actionType
        )?.label.trim()
      : undefined;
  if (actionLabel) {
    return actionLabel;
  }
  return typeof actionType === "string" && actionType.trim()
    ? "Unavailable action"
    : "Action";
}

/** The visible workflow name React Flow announces for a node. */
export function workflowNodeAriaLabel(
  data: WorkflowNodeData,
  catalog?: ExtensionCatalog
): string {
  const comparison = data[COMPARISON_NODE_ANNOTATION];
  if (comparison) {
    return `${comparisonNodeTitle(data, catalog)}, ${comparisonChangeLabel(comparison.kind)}`;
  }
  let result: string;
  const nodeLabel = data.label?.trim();
  if (nodeLabel) {
    result = nodeLabel;
  } else {
    const actionType = data.config?.actionType;
    result =
      typeof actionType === "string" && actionType.trim()
        ? ((catalog ? findAction(catalog, actionType)?.label : undefined) ??
          actionType)
        : data.type === "lifecycle"
          ? "Lifecycle"
          : data.type === "group"
            ? "Group"
            : "Action";
  }
  return result;
}

/**
 * Strip editor-only fields before a node crosses into the persist path. What is
 * selected and what is mid-drag belong to the session looking at the graph, so
 * neither is written; `workflowNodeAttributesSchema` names neither either, and
 * a key it does not name is dropped on the way back in.
 */
export function toPersistedNode(node: WorkflowNode): PersistedWorkflowNode {
  const {
    status: _status,
    issues: _issues,
    [COMPARISON_NODE_ANNOTATION]: _comparison,
    ...data
  } = node.data;
  const persisted: PersistedWorkflowNode = {
    id: node.id,
    position: node.position,
    data,
    type: node.type,
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

/**
 * Every node worth persisting, in persisted shape.
 *
 * The one place that decides which editor node types are not real graph nodes.
 * The save payload and the validation pass both come through here, so a second
 * editor-only type cannot end up dropped by one and walked by the other.
 */
export function toPersistedNodes(
  nodes: WorkflowNode[]
): PersistedWorkflowNode[] {
  return nodes.filter((node) => node.type !== "add").map(toPersistedNode);
}

export function toPersistedEdge(edge: WorkflowEdge): PersistedWorkflowEdge {
  const {
    displayLabel: _displayLabel,
    inactive: _inactive,
    [COMPARISON_EDGE_ANNOTATION]: comparison,
    ...rest
  } = edge.data ?? {};
  return {
    id: comparison?.sourceId ?? edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    data: isEmptyObject(rest) ? undefined : rest,
  };
}

export function toEditorNode(node: PersistedWorkflowNode): WorkflowNode {
  // React Flow declares `type`, `width` and `height` as optional keys, so a
  // persisted node that sets none of them leaves them out here.
  const editor: WorkflowNode = omitUndefined({
    id: node.id,
    position: node.position,
    type: node.type,
    width: node.width,
    height: node.height,
    ariaLabel: workflowNodeAriaLabel(node.data),
    // No status: a freshly converted node carries no run of its own. The
    // graph store merges a run's status onto whichever graph is on screen at
    // display time, so this node's `data` never needs one baked in.
    data: { ...node.data },
  });
  // React Flow declares `measured` and the two sizes inside it as optional
  // keys, so an unmeasured node leaves them out here.
  if (node.measured) {
    editor.measured = omitUndefined(node.measured);
  }
  if (node.parentId) {
    editor.parentId = node.parentId;
    editor.extent = "parent";
    editor.draggable = false;
    editor.connectable = false;
  }
  return editor;
}

// The persisted graph carries structure alone. How an edge draws is the
// canvas's decision, through `defaultEdgeOptions`, and what is selected belongs
// to the session looking at it.
export function toEditorEdge(edge: PersistedWorkflowEdge): WorkflowEdge {
  // React Flow declares the handle keys and `data` as optional, so a handle
  // the persisted edge does not name is omitted.
  return omitUndefined({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    data: edge.data,
  });
}
