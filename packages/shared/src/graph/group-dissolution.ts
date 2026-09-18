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
import {
  offsetClearOfRectangles,
  overviewCardRectangle,
  overviewCardRectangles,
  type NodeRectangle,
  type PlacedNode,
} from "#src/graph/node-placement";
import type { WorkflowNode } from "#src/graph/types";

type Position = { x: number; y: number };

/** A node with the canvas position dissolution rewrites. */
export type DissolvableNode = GroupGraphNode & { position: Position };

/** Builds the node a member becomes once its frame is gone, with no `parentId`. */
export type ReleaseMember<N extends DissolvableNode> = (input: {
  frame: N;
  member: N;
}) => N;

/**
 * Where a member of a dissolved frame lands: where the focused Group canvas
 * draws it, translated by the frame's position. Members retain their relative
 * arrangement, then move together by
 * `offsetClearOfRectangles`, down and right until no card the overview draws
 * overlaps them. Those cards are every top-level node in `graph` except a
 * frame already dissolved, plus the members already released from such a
 * frame. Each frame is placed once, from `graph` as it was given.
 */
export function groupCanvasReleasePosition(graph: {
  nodes: readonly PlacedNode[];
}): (input: { frame: DissolvableNode; member: DissolvableNode }) => Position {
  const offsetsByFrame = new Map<string, Position>();
  const released: NodeRectangle[] = [];

  const placeFrame = (frame: DissolvableNode): Position => {
    const unmoved = graph.nodes
      .filter((node) => node.parentId === frame.id)
      .map((member) =>
        overviewCardRectangle({
          ...member,
          position: {
            x: frame.position.x + member.position.x,
            y: frame.position.y + member.position.y,
          },
        })
      );
    const obstacles = [
      ...overviewCardRectangles(
        graph.nodes.filter(
          (node) => node.id !== frame.id && !offsetsByFrame.has(node.id)
        )
      ),
      ...released,
    ];
    const offset = offsetClearOfRectangles(unmoved, obstacles);
    released.push(
      ...unmoved.map((rectangle) => ({
        ...rectangle,
        x: rectangle.x + offset.x,
        y: rectangle.y + offset.y,
      }))
    );
    return offset;
  };

  return ({ frame, member }) => {
    let offset = offsetsByFrame.get(frame.id);
    if (!offset) {
      offset = placeFrame(frame);
      offsetsByFrame.set(frame.id, offset);
    }
    return {
      x: frame.position.x + member.position.x + offset.x,
      y: frame.position.y + member.position.y + offset.y,
    };
  };
}

/**
 * Releases each persisted member of a frame in `graph` at
 * `groupCanvasReleasePosition`, with no `parentId`. The build agent dissolves
 * with it, so a Group it dissolves leaves its members where the editor's
 * Ungroup leaves them.
 */
export function releaseAtGroupCanvasPosition(graph: {
  nodes: readonly WorkflowNode[];
}): ReleaseMember<WorkflowNode> {
  const place = groupCanvasReleasePosition(graph);
  return (input) => {
    const { parentId: _parentId, ...released } = input.member;
    return { ...released, position: place(input) };
  };
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
