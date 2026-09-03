/**
 * Every size the canvas is laid out from: how large a node draws, how far
 * auto-layout spaces two of them, and the compact geometry inside a Group.
 * Auto-layout reserves these before React Flow has measured a card.
 */

export const WORKFLOW_NODE_WIDTH = 192;
export const WORKFLOW_NODE_HEIGHT = 112;

/** Gap between two siblings of one rank; dagre's `nodesep`. */
export const NODE_SPACING = 132;
/** Gap between one rank and the next; dagre's `ranksep`. */
export const RANK_SPACING = 88;

/** Width and height the card draws at. Event Split passes a wider width. */
export function workflowNodeSize(width: number = WORKFLOW_NODE_WIDTH): {
  width: number;
  height: number;
} {
  return { width, height: WORKFLOW_NODE_HEIGHT };
}

/** Compact card a Group draws for each nested lookup / Condition. */
export const GROUP_CHILD_WIDTH = 188;
export const GROUP_CHILD_HEIGHT = 56;
export const GROUP_HEADER_HEIGHT = 36;
export const GROUP_PAD = 12;
/** Between two members of one row, which nothing is drawn in. */
export const GROUP_COLUMN_GAP = 24;
/**
 * Between two rows, which the interior edge is drawn in. `edge-path.ts` turns
 * its corner 16px out of each end, so a shorter gap would leave the fan-in with
 * no straight run to read.
 */
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

/**
 * How wide one Event Split outlet's slot is, in pixels. Wide enough for the chip
 * naming its Event, which is why the card grows with its outlets rather than
 * spacing them inside the width every other node has.
 */
const EVENT_SPLIT_OUTLET_WIDTH = 132;

/** How wide an Event Split card draws for the outlets it has. */
export function eventSplitCardWidth(outletCount: number): number {
  return outletCount > 1
    ? outletCount * EVENT_SPLIT_OUTLET_WIDTH
    : WORKFLOW_NODE_WIDTH;
}

/**
 * The icon a node draws beside or above its title, as a Tailwind size. One
 * value so a resize is one edit; `GeneratedImageThumbnail` also matches its
 * `<img>` width and height to it in pixels.
 */
export const NODE_ICON_CLASS = "size-4";
export const NODE_ICON_PX = 16;
