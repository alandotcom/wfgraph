/**
 * Every size the canvas is laid out from: how large a node draws and how far
 * auto-layout spaces two of them. Auto-layout reserves these before React Flow
 * has measured a card.
 */

export {
  eventSplitCardWidth,
  NODE_SPACING,
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
  workflowNodeSize,
} from "@wfgraph/shared/graph/workflow-layout-geometry";

/**
 * The icon a node draws beside or above its title, as a Tailwind size. One
 * value so a resize is one edit; `GeneratedImageThumbnail` also matches its
 * `<img>` width and height to it in pixels.
 */
export const NODE_ICON_CLASS = "size-4";
export const NODE_ICON_PX = 16;

/**
 * Where a Condition card's True and False outlets sit along its outlet side, as
 * a fraction of that side's length. The card draws its handles there, and the
 * focused Group canvas routes each branch's edge from there.
 */
export const CONDITION_OUTLET_FRACTION = { true: 0.38, false: 0.62 } as const;
