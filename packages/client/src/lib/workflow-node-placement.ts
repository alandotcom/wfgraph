/**
 * Where a new step goes when the person adding it did not point at a spot.
 *
 * The canvas centre is the obvious place and is also where the last step landed,
 * so a candidate that overlaps something already on the graph steps down and to
 * the right until it is clear. Positions are canvas coordinates and name a
 * node's top-left corner, which is what React Flow stores.
 */

import { keyBy } from "es-toolkit/array";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

/** How far one step down and right a blocked candidate moves. */
const CASCADE_OFFSET = 20;

export type NodeRectangle = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * Convert editor nodes into canvas-space rectangles.
 *
 * React Flow owns the authoritative absolute position after initialization.
 * The stored parent chain covers nodes before that measurement is available.
 */
export function workflowNodeRectangles(
  nodes: readonly WorkflowNode[],
  absolutePositionForId: (
    nodeId: string
  ) => { readonly x: number; readonly y: number } | undefined = () => undefined
): NodeRectangle[] {
  const nodesById = keyBy(nodes, (node) => node.id);

  return nodes
    .filter((node) => node.type !== "add")
    .map((node) => {
      const measuredPosition = absolutePositionForId(node.id);
      let x = measuredPosition?.x ?? node.position.x;
      let y = measuredPosition?.y ?? node.position.y;

      if (!measuredPosition) {
        const visited = new Set([node.id]);
        let parentId = node.parentId;
        while (parentId && !visited.has(parentId)) {
          visited.add(parentId);
          const parent = nodesById[parentId];
          if (!parent) {
            break;
          }
          x += parent.position.x;
          y += parent.position.y;
          parentId = parent.parentId;
        }
      }

      return {
        x,
        y,
        width: node.measured?.width ?? node.width ?? WORKFLOW_NODE_WIDTH,
        height: node.measured?.height ?? node.height ?? WORKFLOW_NODE_HEIGHT,
      };
    });
}

/**
 * `position`, moved clear of every node in `nodes`.
 *
 * The test is full rectangles, not top-left corners. Comparing corners against a
 * 20px threshold meant a node offset by 21px counted as clear, so a new step
 * landed on top of a neighbour it overlapped by nearly its whole width.
 */
export function positionClearOfNodes(
  position: { readonly x: number; readonly y: number },
  nodes: readonly NodeRectangle[]
): { x: number; y: number } {
  const candidate = { x: position.x, y: position.y };

  let overlaps = nodes.some(
    (node) =>
      candidate.x < node.x + node.width &&
      candidate.x + WORKFLOW_NODE_WIDTH > node.x &&
      candidate.y < node.y + node.height &&
      candidate.y + WORKFLOW_NODE_HEIGHT > node.y
  );
  while (overlaps) {
    candidate.x += CASCADE_OFFSET;
    candidate.y += CASCADE_OFFSET;
    overlaps = nodes.some(
      (node) =>
        candidate.x < node.x + node.width &&
        candidate.x + WORKFLOW_NODE_WIDTH > node.x &&
        candidate.y < node.y + node.height &&
        candidate.y + WORKFLOW_NODE_HEIGHT > node.y
    );
  }

  return candidate;
}
