/**
 * How large a node draws on the canvas.
 * Auto-layout reserves this size before React Flow has measured the card.
 */

export const WORKFLOW_NODE_WIDTH = 192;
export const WORKFLOW_NODE_HEIGHT = 112;

/**
 * Tailwind classes that draw a node at WORKFLOW_NODE_WIDTH × WORKFLOW_NODE_HEIGHT.
 * `h-28` is 112px and `w-48` is 192px; keep those in lockstep with the constants.
 */
export const workflowNodeClassName =
  "flex h-28 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out";

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
