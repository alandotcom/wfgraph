/**
 * What handle id a new edge should be stored with, given where it was dragged
 * from. Pulled out of the canvas as a pure function so the rule is testable
 * without mounting React Flow.
 */

import {
  isConditionActionNode,
  normalizeConditionBranch,
} from "@rova/shared/workflow/condition-branch";
import {
  isLifecycleOutlet,
  LIFECYCLE_STARTED_HANDLE,
} from "@rova/shared/workflow/lifecycle-outlets";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/workflow/types";

/**
 * Which of a Condition node's two branches an edge with no handle takes: the
 * one that has no edge yet, or True if both already have one.
 */
export function inferConditionBranch(
  sourceNodeId: string,
  edges: readonly WorkflowEdge[]
): "true" | "false" {
  const outgoing = edges.filter((edge) => edge.source === sourceNodeId);
  const hasTrue = outgoing.some(
    (edge) => normalizeConditionBranch(edge.sourceHandle) === "true"
  );
  if (!hasTrue) {
    return "true";
  }

  const hasFalse = outgoing.some(
    (edge) => normalizeConditionBranch(edge.sourceHandle) === "false"
  );
  if (!hasFalse) {
    return "false";
  }

  return "true";
}

/**
 * The Lifecycle Node's outlet is named whichever way the edge was drawn, so a
 * connection made programmatically says the same thing as one dragged from
 * the handle. Started is a fallback for a connection carrying no handle at
 * all; the save refuses an edge from here that names none.
 */
export function normalizeSourceHandleForConnection(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  sourceNodeId: string;
  sourceHandle: string | null | undefined;
}): string | null {
  const { nodes, edges, sourceNodeId, sourceHandle } = input;

  const explicitBranch = normalizeConditionBranch(sourceHandle);
  if (explicitBranch) {
    return explicitBranch;
  }

  const sourceNode = nodes.find((node) => node.id === sourceNodeId);

  if (sourceNode?.data.type === "trigger") {
    return isLifecycleOutlet(sourceHandle)
      ? sourceHandle
      : LIFECYCLE_STARTED_HANDLE;
  }

  if (!isConditionActionNode(sourceNode)) {
    return sourceHandle ?? null;
  }

  return inferConditionBranch(sourceNodeId, edges);
}
