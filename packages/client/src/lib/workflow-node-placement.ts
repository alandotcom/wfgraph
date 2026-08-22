/**
 * Where a new step goes when the person adding it did not point at a spot.
 *
 * The canvas centre is the obvious place and is also where the last step landed,
 * so a candidate that overlaps something already on the graph steps down and to
 * the right until it is clear. Positions are canvas coordinates and name a
 * node's top-left corner, which is what React Flow stores.
 */

import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";

/** How far one step down and right a blocked candidate moves. */
const CASCADE_OFFSET = 20;

/** After this many moves the graph is dense enough that a stack is fine. */
const MAX_CASCADE_STEPS = 20;

type Positioned = {
  readonly position: { readonly x: number; readonly y: number };
};

/**
 * `position`, moved clear of every node in `nodes`.
 *
 * The test is full rectangles, not top-left corners. Comparing corners against a
 * 20px threshold meant a node offset by 21px counted as clear, so a new step
 * landed on top of a neighbour it overlapped by nearly its whole width.
 */
export function positionClearOfNodes(
  position: { readonly x: number; readonly y: number },
  nodes: readonly Positioned[]
): { x: number; y: number } {
  const candidate = { x: position.x, y: position.y };

  for (let step = 0; step < MAX_CASCADE_STEPS; step += 1) {
    const overlaps = nodes.some(
      (node) =>
        Math.abs(node.position.x - candidate.x) < WORKFLOW_NODE_WIDTH &&
        Math.abs(node.position.y - candidate.y) < WORKFLOW_NODE_HEIGHT
    );
    if (!overlaps) {
      break;
    }
    candidate.x += CASCADE_OFFSET;
    candidate.y += CASCADE_OFFSET;
  }

  return candidate;
}
