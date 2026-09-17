/**
 * Removes Group frames and keeps their members. The caller's `releaseMember`
 * builds each released member, which keeps its id, data and stored edges and
 * loses its `parentId`. Stored edges never name a frame, so dissolution changes
 * the node list alone, and it answers the given array when it removes no frame.
 */

import {
  analyzeGroupBoundaryById,
  isGroupNode,
  type GroupGraphNode,
} from "#src/graph/group-boundary";
import {
  groupStructureRefusalReason,
  type GroupStructureEdge,
} from "#src/graph/group-structure";
import {
  groupCanvasPositions,
  groupLayoutDirection,
  undersizedGroupIds,
} from "#src/graph/node-group";
import {
  offsetClearOfRectangles,
  overviewCardRectangle,
  overviewCardRectangles,
  type NodeRectangle,
  type PlacedNode,
} from "#src/graph/node-placement";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/graph/workflow-layout-geometry";

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
 * draws it, moved so the Group's slots are centred on the collapsed card's
 * centre line and its first row starts at the card's top, along the frame's
 * stored layout direction. The members of one frame then move together by
 * `offsetClearOfRectangles`, down and right until no card the overview draws
 * overlaps them. Those cards are every top-level node in `graph` except a
 * frame already dissolved, plus the members already released from such a
 * frame. Each frame is placed once, from `graph` as it was given.
 */
export function groupCanvasReleasePosition(graph: {
  nodes: readonly PlacedNode[];
  edges: readonly WorkflowEdge[];
}): (input: { frame: DissolvableNode; member: DissolvableNode }) => Position {
  // Maps, because node and Group ids are chosen by the builder.
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const positionsByFrame = new Map<string, Map<string, Position>>();
  const released: NodeRectangle[] = [];

  const placeFrame = (frame: DissolvableNode): Map<string, Position> => {
    const boundary = analyzeGroupBoundaryById({
      nodes: graph.nodes,
      edges: graph.edges,
      groupId: frame.id,
    });
    const slots = groupCanvasPositions({
      memberIds: boundary.memberIds,
      interiorEdges: boundary.interiorEdges,
      direction: groupLayoutDirection(frame),
    });
    const unmoved = boundary.memberIds.map((memberId) => {
      const slot = slots.get(memberId) ?? { x: -WORKFLOW_NODE_WIDTH / 2, y: 0 };
      const member = nodeById.get(memberId);
      const position = {
        x: frame.position.x + WORKFLOW_NODE_WIDTH / 2 + slot.x,
        y: frame.position.y + slot.y,
      };
      return {
        memberId,
        rectangle: member
          ? overviewCardRectangle({ ...member, position })
          : {
              ...position,
              width: WORKFLOW_NODE_WIDTH,
              height: WORKFLOW_NODE_HEIGHT,
            },
      };
    });
    const obstacles = [
      ...overviewCardRectangles(
        graph.nodes.filter(
          (node) => node.id !== frame.id && !positionsByFrame.has(node.id)
        )
      ),
      ...released,
    ];
    const offset = offsetClearOfRectangles(
      unmoved.map((entry) => entry.rectangle),
      obstacles
    );
    const positions = new Map<string, Position>();
    for (const { memberId, rectangle } of unmoved) {
      const moved = {
        ...rectangle,
        x: rectangle.x + offset.x,
        y: rectangle.y + offset.y,
      };
      released.push(moved);
      positions.set(memberId, { x: moved.x, y: moved.y });
    }
    return positions;
  };

  return ({ frame, member }) => {
    let positions = positionsByFrame.get(frame.id);
    if (!positions) {
      positions = placeFrame(frame);
      positionsByFrame.set(frame.id, positions);
    }
    return (
      positions.get(member.id) ?? {
        x: frame.position.x,
        y: frame.position.y,
      }
    );
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
  edges: readonly WorkflowEdge[];
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
