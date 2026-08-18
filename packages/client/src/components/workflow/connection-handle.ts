/**
 * What handle id a new edge should be stored with, given where it was dragged
 * from. Pulled out of the canvas as a pure function so the rule is testable
 * without mounting React Flow.
 */

import {
  isConditionActionNode,
  normalizeConditionBranch,
} from "@wfgraph/shared/conditions/condition-branch";
import {
  eventSplitOutlet,
  eventSplitOutletEvent,
  isEventSplitNode,
} from "@wfgraph/shared/lifecycle/event-split";
import {
  isLifecycleOutlet,
  LIFECYCLE_STARTED_HANDLE,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { eventsReachingTarget } from "#src/lib/upstream-node-fields";
import {
  groupOutletHandle,
  isGroupNode,
} from "@wfgraph/shared/graph/node-group";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

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
 * Which of an Event Split's outlets an edge with no handle takes: the first
 * Event nothing is connected to, or the first Event when every outlet is taken.
 *
 * Null where no Event reaches the split, which is a node with no outlets to
 * choose between. The save refuses the edge and says so.
 */
export function inferEventSplitOutlet(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  sourceNodeId: string;
  catalog: ExtensionCatalog;
}): string | null {
  const { nodes, edges, sourceNodeId, catalog } = input;
  const outlets = eventsReachingTarget({
    targetNodeId: sourceNodeId,
    nodes,
    edges,
    catalog,
  });

  const taken = new Set(
    edges
      .filter((edge) => edge.source === sourceNodeId)
      .map((edge) => edge.sourceHandle)
  );

  const chosen =
    outlets.find((event) => !taken.has(eventSplitOutlet(event.name))) ??
    outlets[0];

  return chosen ? eventSplitOutlet(chosen.name) : null;
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
  catalog: ExtensionCatalog;
}): string | null {
  const { nodes, edges, sourceNodeId, sourceHandle, catalog } = input;

  const explicitBranch = normalizeConditionBranch(sourceHandle);
  if (explicitBranch) {
    return explicitBranch;
  }

  const sourceNode = nodes.find((node) => node.id === sourceNodeId);

  if (isGroupNode(sourceNode)) {
    return groupOutletHandle(sourceNode) ?? sourceHandle ?? null;
  }

  if (sourceNode?.data.type === "lifecycle") {
    return isLifecycleOutlet(sourceHandle)
      ? sourceHandle
      : LIFECYCLE_STARTED_HANDLE;
  }

  if (isEventSplitNode(sourceNode)) {
    const draggedFrom = eventSplitOutletEvent(sourceHandle);
    return draggedFrom
      ? eventSplitOutlet(draggedFrom)
      : inferEventSplitOutlet({ nodes, edges, sourceNodeId, catalog });
  }

  if (!isConditionActionNode(sourceNode)) {
    return sourceHandle ?? null;
  }

  return inferConditionBranch(sourceNodeId, edges);
}
