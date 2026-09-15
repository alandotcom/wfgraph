/**
 * Removes Group frames and keeps their members. The caller's `releaseMember`
 * builds each released member, which keeps its id, data and stored edges and
 * loses its `parentId`. Stored edges never name a frame, so dissolution changes
 * the node list alone, and it answers the given array when it removes no frame.
 */

import { isGroupNode, type GroupGraphNode } from "#src/graph/group-boundary";
import {
  groupStructureRefusalReason,
  type GroupStructureEdge,
} from "#src/graph/group-structure";
import { undersizedGroupIds } from "#src/graph/node-group";
import type { WorkflowNode } from "#src/graph/types";

type Position = { x: number; y: number };

/** A node with the canvas position dissolution rewrites. */
export type DissolvableNode = GroupGraphNode & { position: Position };

/**
 * Builds the node a member becomes once its frame is gone. `member.position`
 * is relative to `frame.position`, and the answer carries no `parentId`.
 */
export type ReleaseMember<N extends DissolvableNode> = (input: {
  frame: N;
  member: N;
}) => N;

/** The canvas position of a member drawn at `member.position` inside `frame`. */
export function positionInFrame(input: {
  frame: DissolvableNode;
  member: DissolvableNode;
}): Position {
  return {
    x: input.frame.position.x + input.member.position.x,
    y: input.frame.position.y + input.member.position.y,
  };
}

/** Releases a persisted member at `positionInFrame`, with no `parentId`. */
export function releaseAtFramePosition(input: {
  frame: WorkflowNode;
  member: WorkflowNode;
}): WorkflowNode {
  const { parentId: _parentId, ...released } = input.member;
  return { ...released, position: positionInFrame(input) };
}

/**
 * Removes every Group frame named in `groupIds` and releases each node whose
 * `parentId` names one of them. An id that names no Group frame is ignored.
 */
export function dissolveGroups<L extends readonly DissolvableNode[]>(input: {
  nodes: L;
  groupIds: ReadonlySet<string>;
  releaseMember: ReleaseMember<L[number]>;
}): L | L[number][] {
  // A Map, because Group ids are chosen by the builder and a plain object would
  // answer an id named `constructor` with a prototype member.
  const frameById = new Map<string, L[number]>(
    input.nodes
      .filter((node) => input.groupIds.has(node.id) && isGroupNode(node))
      .map((node) => [node.id, node])
  );
  if (frameById.size === 0) {
    return input.nodes;
  }

  return input.nodes
    .filter((node) => !frameById.has(node.id))
    .map((node) => {
      const frame =
        node.parentId === undefined ? undefined : frameById.get(node.parentId);
      return frame ? input.releaseMember({ frame, member: node }) : node;
    });
}

export type GroupRepair<L extends readonly DissolvableNode[]> =
  | {
      ok: true;
      /** The graph's nodes with every undersized Group dissolved. */
      nodes: L | L[number][];
      /** The frames dissolution removed, empty when every Group was whole. */
      dissolvedGroupIds: string[];
    }
  | { ok: false; reason: string };

/**
 * Holds a graph written outside the canvas to the Group rules a draft save
 * enforces, then dissolves each Group holding fewer than two steps. A graph
 * failing `groupStructureRefusalReason` is refused whole, because dissolution
 * cannot repair a member naming a missing frame or an edge touching a frame.
 */
export function repairGroups<L extends readonly DissolvableNode[]>(input: {
  nodes: L;
  edges: readonly GroupStructureEdge[];
  releaseMember: ReleaseMember<L[number]>;
}): GroupRepair<L> {
  const reason = groupStructureRefusalReason(input);
  if (reason) {
    return { ok: false, reason };
  }
  const dissolvedGroupIds = undersizedGroupIds(input.nodes);
  return {
    ok: true,
    nodes: dissolveGroups({
      nodes: input.nodes,
      groupIds: new Set(dissolvedGroupIds),
      releaseMember: input.releaseMember,
    }),
    dissolvedGroupIds,
  };
}
