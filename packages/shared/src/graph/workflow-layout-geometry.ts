/**
 * Persisted node geometry used by automatic layout and by the editor's cards.
 * The layout reserves these sizes before a renderer has measured a node.
 */

export const WORKFLOW_NODE_WIDTH = 192;
export const WORKFLOW_NODE_HEIGHT = 112;

/** Gap between two siblings of one rank; dagre's `nodesep`. */
export const NODE_SPACING = 108;
/** Gap between one rank and the next; dagre's `ranksep`. */
export const RANK_SPACING = 68;
/** Cousins retain a little more separation than direct siblings. */
export const COUSIN_SPACING_FACTOR = 1.5;

/** Width and height of a standard workflow card. */
export function workflowNodeSize(width: number = WORKFLOW_NODE_WIDTH): {
  width: number;
  height: number;
} {
  return { width, height: WORKFLOW_NODE_HEIGHT };
}

/** Width reserved for one Event Split outlet and its Event-name chip. */
const EVENT_SPLIT_OUTLET_WIDTH = 132;

/** Returns the rendered width of an Event Split card. */
export function eventSplitCardWidth(outletCount: number): number {
  return outletCount > 1
    ? outletCount * EVENT_SPLIT_OUTLET_WIDTH
    : WORKFLOW_NODE_WIDTH;
}

/**
 * A Group drawn in place is a region around its members. Its node box starts
 * at the frame's stored position, where members' local positions start, and
 * reaches `GROUP_REGION_PADDING` past their right and bottom edges. The region
 * draws its header and the same padding above and to the left of that box.
 */
export const GROUP_REGION_PADDING = 24;
/** The height of a Group region's header, which names and selects the Group. */
export const GROUP_REGION_HEADER_HEIGHT = 40;

type RegionMember = {
  position: { x: number; y: number };
  width?: number | undefined;
  height?: number | undefined;
  measured?: { width?: number | undefined; height?: number | undefined };
};

/**
 * The size of a Group region's node box for `members`, whose positions are
 * local to the frame. A Group with no member draws at the card size.
 */
export function groupRegionBox(members: readonly RegionMember[]): {
  width: number;
  height: number;
} {
  if (members.length === 0) {
    return workflowNodeSize();
  }
  const right = Math.max(
    ...members.map(
      (member) =>
        member.position.x +
        (member.measured?.width ?? member.width ?? WORKFLOW_NODE_WIDTH)
    )
  );
  const bottom = Math.max(
    ...members.map(
      (member) =>
        member.position.y +
        (member.measured?.height ?? member.height ?? WORKFLOW_NODE_HEIGHT)
    )
  );
  return {
    width: Math.max(right, 0) + GROUP_REGION_PADDING,
    height: Math.max(bottom, 0) + GROUP_REGION_PADDING,
  };
}

/** How far a region's drawn outline reaches above and left of its node box. */
export const GROUP_REGION_INSET = {
  left: GROUP_REGION_PADDING,
  top: GROUP_REGION_HEADER_HEIGHT + GROUP_REGION_PADDING,
} as const;
