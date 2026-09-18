/**
 * Where a new step goes when the person adding it did not point at a spot.
 *
 * The canvas centre is the obvious place and is also where the last step
 * landed, so a candidate that overlaps something already on the graph steps
 * down and to the right until it is clear, by `offsetClearOfRectangles`.
 * Positions are canvas coordinates naming a node's top-left corner.
 */

import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  offsetClearOfRectangles,
  type NodeRectangle,
} from "@wfgraph/shared/graph/node-placement";

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
  // A Map rather than a keyBy record: `parentId` comes from the persisted
  // graph, and a plain object would answer a parent named `constructor` with a
  // prototype member instead of undefined.
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

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
          const parent = nodesById.get(parentId);
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
 * `position`, moved clear of every rectangle in `nodes`. The test is full
 * rectangles: a new step whose corner is 21px from a neighbour still overlaps
 * it by nearly its whole width, so it moves.
 */
export function positionClearOfNodes(
  position: { readonly x: number; readonly y: number },
  nodes: readonly NodeRectangle[]
): { x: number; y: number } {
  const offset = offsetClearOfRectangles(
    [{ ...position, width: WORKFLOW_NODE_WIDTH, height: WORKFLOW_NODE_HEIGHT }],
    nodes
  );
  return { x: position.x + offset.x, y: position.y + offset.y };
}
