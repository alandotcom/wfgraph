/**
 * How large a node draws on the canvas.
 *
 * The auto-layout has to reserve a node's width before React Flow has measured
 * anything, so the card and the layout both take the width from here.
 */

export const WORKFLOW_NODE_WIDTH = 192;
export const WORKFLOW_NODE_HEIGHT = 192;

/** Compact card a Group draws for each nested lookup / Condition. */
export const GROUP_CHILD_WIDTH = 188;
export const GROUP_CHILD_HEIGHT = 56;
export const GROUP_HEADER_HEIGHT = 36;
export const GROUP_PAD = 12;
export const GROUP_CHILD_GAP = 8;

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
      (cols - 1) * GROUP_CHILD_GAP +
      GROUP_PAD,
    height:
      GROUP_HEADER_HEIGHT +
      GROUP_PAD +
      stacked * GROUP_CHILD_HEIGHT +
      (stacked - 1) * GROUP_CHILD_GAP +
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
