/**
 * The referential integrity every stored Group keeps. A member names an existing
 * Group frame through `parentId`, a frame sits inside no other frame, only
 * executable steps are members, and no stored edge touches a frame. Whether a
 * Group's boundary is one a published workflow may hold is a separate question.
 */

import { isGroupNode } from "#src/graph/group-boundary";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";

/** The name a refusal message gives a node: its trimmed label, or its id. */
export function nodeLabel(node: WorkflowNode): string {
  return node.data.label?.trim() || node.id;
}

function memberRefusal(
  node: WorkflowNode,
  parentId: string,
  nodeById: ReadonlyMap<string, WorkflowNode>
): string | null {
  const parent = nodeById.get(parentId);
  if (!parent) {
    return `Node "${nodeLabel(node)}" names a parent Group the graph does not contain`;
  }
  if (!isGroupNode(parent)) {
    return `Node "${nodeLabel(node)}" names a parent that is not a Group`;
  }
  if (isGroupNode(node)) {
    return `Group "${nodeLabel(node)}" cannot sit inside another Group`;
  }
  if (node.data.type !== "action") {
    return `Node "${nodeLabel(node)}" cannot be a member of Group "${nodeLabel(parent)}", because only action steps can be Group members`;
  }
  return null;
}

/**
 * Returns the first Group integrity violation in a graph, or null when every
 * Group reference holds. Edges whose ends name no node are left to the caller's
 * own missing-node check.
 */
export function groupStructureRefusalReason(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): string | null {
  // A Map, because node ids are chosen by the builder and a plain object would
  // answer a node named `constructor` with a prototype member.
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));

  for (const node of input.nodes) {
    if (node.parentId === undefined) {
      continue;
    }
    const refusal = memberRefusal(node, node.parentId, nodeById);
    if (refusal) {
      return refusal;
    }
  }

  for (const edge of input.edges) {
    const frame = [nodeById.get(edge.source), nodeById.get(edge.target)].find(
      (end) => isGroupNode(end)
    );
    if (frame) {
      return `Edge "${edge.id}" connects to Group "${nodeLabel(frame)}". Connect a step inside the Group.`;
    }
  }

  return null;
}
