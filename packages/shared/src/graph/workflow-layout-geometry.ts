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
