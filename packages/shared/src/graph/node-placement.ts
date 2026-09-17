/**
 * Clear space for nodes an authoring action puts on the overview: an added
 * step, a pasted selection, or a dissolved Group's members. The placed nodes
 * move as one block, down and right, until no card already drawn overlaps
 * them; existing nodes never move. Positions name a node's top-left corner.
 */

import { isGroupNode, type GroupGraphNode } from "#src/graph/group-boundary";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/graph/workflow-layout-geometry";

/** How far one step down and right a blocked block moves. */
const CASCADE_OFFSET = 20;

export type NodeRectangle = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** The fields a node's drawn rectangle is read from. */
export type PlacedNode = GroupGraphNode & {
  type?: string | undefined;
  position: { x: number; y: number };
  width?: number | undefined;
  height?: number | undefined;
  measured?:
    | { width?: number | undefined; height?: number | undefined }
    | undefined;
};

/**
 * The rectangle `node` draws as a top-level card at `node.position`. A Group
 * frame draws as its collapsed card, whatever size its frame stores.
 */
export function overviewCardRectangle(node: PlacedNode): NodeRectangle {
  if (isGroupNode(node)) {
    return {
      ...node.position,
      width: WORKFLOW_NODE_WIDTH,
      height: WORKFLOW_NODE_HEIGHT,
    };
  }
  return {
    ...node.position,
    width: node.measured?.width ?? node.width ?? WORKFLOW_NODE_WIDTH,
    height: node.measured?.height ?? node.height ?? WORKFLOW_NODE_HEIGHT,
  };
}

/**
 * The rectangles of every card the overview draws from `nodes`: each top-level
 * node, with a Group at its collapsed size. A Group member is hidden on the
 * overview and an add placeholder is no card, so neither is included.
 */
export function overviewCardRectangles(
  nodes: readonly PlacedNode[]
): NodeRectangle[] {
  return nodes
    .filter((node) => node.type !== "add" && node.parentId === undefined)
    .map(overviewCardRectangle);
}

/** Whether two rectangles share any area; touching edges do not overlap. */
export function rectanglesOverlap(a: NodeRectangle, b: NodeRectangle): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * The offset that moves every rectangle in `block` together, in equal steps
 * down and right, until none of them overlaps a rectangle in `obstacles`.
 * Answers `{ x: 0, y: 0 }` when `block` is already clear.
 */
export function offsetClearOfRectangles(
  block: readonly NodeRectangle[],
  obstacles: readonly NodeRectangle[]
): { x: number; y: number } {
  let step = 0;
  const blocked = () =>
    block.some((rectangle) =>
      obstacles.some((obstacle) =>
        rectanglesOverlap(
          {
            ...rectangle,
            x: rectangle.x + step * CASCADE_OFFSET,
            y: rectangle.y + step * CASCADE_OFFSET,
          },
          obstacle
        )
      )
    );
  while (blocked()) {
    step += 1;
  }
  return { x: step * CASCADE_OFFSET, y: step * CASCADE_OFFSET };
}
