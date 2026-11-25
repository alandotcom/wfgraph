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
 * The type size of a compact card's step number and title, in canvas pixels.
 * It draws at 11px on screen at zoom 0.46. The seeded 16-step workflow fits
 * the canvas between the outline and details columns of a 1440px window at
 * about 0.49, and a wider window fits it at a higher zoom.
 */
export const NODE_COMPACT_TYPE_PX = 24;

/**
 * Where a Condition card's True and False outlets sit along its outlet side, as
 * a fraction of that side's length. The card draws its handles there, and the
 * focused Group canvas routes each branch's edge from there.
 */
export const CONDITION_OUTLET_FRACTION = { true: 0.38, false: 0.62 } as const;
