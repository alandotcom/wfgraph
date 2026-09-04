/**
 * Persisted node geometry used by automatic layout and by the editor's cards.
 * The layout reserves these sizes before a renderer has measured a node.
 */

export const WORKFLOW_NODE_WIDTH = 192;
export const WORKFLOW_NODE_HEIGHT = 112;

/** Gap between two siblings of one rank; dagre's `nodesep`. */
export const NODE_SPACING = 132;
/** Gap between one rank and the next; dagre's `ranksep`. */
export const RANK_SPACING = 88;

/** Width and height of a standard workflow card. */
export function workflowNodeSize(width: number = WORKFLOW_NODE_WIDTH): {
  width: number;
  height: number;
} {
  return { width, height: WORKFLOW_NODE_HEIGHT };
}

/** Compact card a Group draws for each nested lookup or Condition. */
export const GROUP_CHILD_WIDTH = 188;
export const GROUP_CHILD_HEIGHT = 56;
export const GROUP_HEADER_HEIGHT = 36;
export const GROUP_PAD = 12;
/** Space between two members of one Group row. */
export const GROUP_COLUMN_GAP = 24;
/** Space reserved for interior edges between two Group rows. */
export const GROUP_ROW_GAP = 40;

export function groupFrameSize(
  columns: number,
  rows: number
): {
  width: number;
  height: number;
} {
  const cols = Math.max(columns, 1);
  const stacked = Math.max(rows, 1);
  return {
    width:
      GROUP_PAD +
      cols * GROUP_CHILD_WIDTH +
      (cols - 1) * GROUP_COLUMN_GAP +
      GROUP_PAD,
    height:
      GROUP_HEADER_HEIGHT +
      GROUP_PAD +
      stacked * GROUP_CHILD_HEIGHT +
      (stacked - 1) * GROUP_ROW_GAP +
      GROUP_PAD,
  };
}

/** Width reserved for one Event Split outlet and its Event-name chip. */
const EVENT_SPLIT_OUTLET_WIDTH = 132;

/** Returns the rendered width of an Event Split card. */
export function eventSplitCardWidth(outletCount: number): number {
  return outletCount > 1
    ? outletCount * EVENT_SPLIT_OUTLET_WIDTH
    : WORKFLOW_NODE_WIDTH;
}
