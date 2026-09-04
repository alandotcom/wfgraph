/**
 * Every size the canvas is laid out from: how large a node draws, how far
 * auto-layout spaces two of them, and the compact geometry inside a Group.
 * Auto-layout reserves these before React Flow has measured a card.
 */

export {
  eventSplitCardWidth,
  GROUP_CHILD_HEIGHT,
  GROUP_CHILD_WIDTH,
  GROUP_COLUMN_GAP,
  GROUP_HEADER_HEIGHT,
  GROUP_PAD,
  GROUP_ROW_GAP,
  groupFrameSize,
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
