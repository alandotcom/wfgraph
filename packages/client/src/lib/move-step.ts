/**
 * Moving a step one place along its sequence: swapping it with the step
 * before it or after it, as the outline's Alt+Up and Alt+Down do. Pure, so
 * the store's edit only records the result. A swap is possible only between
 * two plain steps joined by one connection, with no other path entering the
 * second or leaving the first, in the same Group or both outside any; every
 * other shape is refused with a sentence saying why.
 */

import { andJoinRefusalReason } from "@wfgraph/shared/graph/and-join";
import { groupStructureRefusalReason } from "@wfgraph/shared/graph/group-structure";
import { isConditionNode } from "@wfgraph/shared/graph/node-config";
import { isEventSplitNode } from "@wfgraph/shared/lifecycle/event-split";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

export type MoveStepDirection = "up" | "down";

export type MoveStepOutcome =
  | { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
  | { refusal: string };

/** Whether a node is a step with one outlet, which can trade places. */
function isPlainStep(node: WorkflowNode | undefined): node is WorkflowNode {
  return (
    node !== undefined &&
    node.data.type === "action" &&
    !isConditionNode(node) &&
    !isEventSplitNode(node)
  );
}

/**
 * The graph with the step `nodeId` swapped with its neighbour in
 * `direction`, or the reason it cannot be. The two steps trade their
 * connections and their positions, so the canvas reads in the new order.
 */
export function moveStepInSequence(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  nodeId: string;
  direction: MoveStepDirection;
}): MoveStepOutcome {
  const { nodes, edges } = input;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const moving = byId.get(input.nodeId);
  if (!isPlainStep(moving)) {
    return {
      refusal:
        "A Condition or an Event Split keeps its place, because its branches move with it.",
    };
  }
  const incoming = (nodeId: string) =>
    edges.filter((edge) => edge.target === nodeId);
  const outgoing = (nodeId: string) =>
    edges.filter((edge) => edge.source === nodeId);

  // The pair in run order: `first` runs before `second`.
  const neighbourEdges =
    input.direction === "up" ? incoming(moving.id) : outgoing(moving.id);
  const [link] = neighbourEdges;
  if (link === undefined) {
    return {
      refusal:
        input.direction === "up"
          ? "This step is first in its path."
          : "This step is last in its path.",
    };
  }
  if (neighbourEdges.length > 1) {
    return {
      refusal:
        input.direction === "up"
          ? "Several paths meet at this step, so it has no one step before it."
          : "Several paths leave this step, so it has no one step after it.",
    };
  }
  const first = byId.get(link.source);
  const second = byId.get(link.target);
  const neighbour = input.direction === "up" ? first : second;
  if (neighbour?.data.type === "lifecycle") {
    return { refusal: "This step is first in its path." };
  }
  if (!isPlainStep(first) || !isPlainStep(second)) {
    return {
      refusal:
        "A Condition or an Event Split keeps its place, because its branches move with it.",
    };
  }
  if (outgoing(first.id).length !== 1 || incoming(second.id).length !== 1) {
    return {
      refusal:
        "These steps sit where paths split or meet, so they cannot trade places.",
    };
  }
  if (first.parentId !== second.parentId) {
    return { refusal: "Move a step within its Group." };
  }

  // first → second becomes second → first: what entered `first` enters
  // `second`, and what left `second` leaves `first`.
  const nextEdges = edges.map((edge): WorkflowEdge => {
    if (edge.id === link.id) {
      return { ...edge, source: second.id, target: first.id };
    }
    if (edge.target === first.id) {
      return { ...edge, target: second.id };
    }
    if (edge.source === second.id) {
      return { ...edge, source: first.id };
    }
    return edge;
  });
  const nextNodes = nodes.map((node) =>
    node.id === first.id
      ? { ...node, position: second.position }
      : node.id === second.id
        ? { ...node, position: first.position }
        : node
  );

  // A swap can put a Wait onto the arm of a join, or change what a Group
  // holds at its edges. Refuse what the draft did not already break.
  const joinBefore = andJoinRefusalReason({ nodes, edges });
  const joinAfter = andJoinRefusalReason({
    nodes: nextNodes,
    edges: nextEdges,
  });
  if (joinAfter !== null && joinBefore === null) {
    return { refusal: joinAfter };
  }
  const groupBefore = groupStructureRefusalReason({ nodes, edges });
  const groupAfter = groupStructureRefusalReason({
    nodes: nextNodes,
    edges: nextEdges,
  });
  if (groupAfter !== null && groupBefore === null) {
    return { refusal: groupAfter };
  }
  return { nodes: nextNodes, edges: nextEdges };
}
