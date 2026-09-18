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
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { eventsReachingTarget } from "#src/lib/upstream-node-fields";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
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

  const sourceNode = nodes.find((node) => node.id === sourceNodeId);

  // A Group card draws one outlet with no handle id, and `fanOutStoreEdges`
  // reads the member ports it stands for from the Group's boundary.
  if (isGroupNode(sourceNode)) {
    return null;
  }

  const explicitBranch = normalizeConditionBranch(sourceHandle);
  if (explicitBranch) {
    return explicitBranch;
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

/** One outlet a step draws, as a menu names it. */
export type StepOutlet = {
  /** The handle the outlet stores, null for a step with one outlet. */
  handle: string | null;
  /** What the outlet is called where a menu lists more than one. */
  label: string | null;
};

/**
 * The outlets of the step `node`, in the order its card draws them: one unnamed
 * outlet for an ordinary step, True and False for a Condition, Started and
 * Canceled for the Lifecycle Node, and one per Event reaching an Event Split.
 * Empty for a step nothing can leave, such as an Event Split no Event reaches.
 */
export function stepOutlets(input: {
  node: WorkflowNode;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): StepOutlet[] {
  const { node } = input;
  if (isConditionActionNode(node)) {
    return [
      { handle: "true", label: "True" },
      { handle: "false", label: "False" },
    ];
  }
  if (node.data.type === "lifecycle") {
    return [
      { handle: LIFECYCLE_STARTED_HANDLE, label: "Started" },
      { handle: LIFECYCLE_CANCELED_HANDLE, label: "Canceled" },
    ];
  }
  if (isEventSplitNode(node)) {
    return eventsReachingTarget({
      targetNodeId: node.id,
      nodes: input.nodes,
      edges: input.edges,
      catalog: input.catalog,
    }).map((event) => ({
      handle: eventSplitOutlet(event.name),
      label: event.label ?? event.name,
    }));
  }
  return [{ handle: null, label: null }];
}
