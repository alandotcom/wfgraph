/**
 * Placement rules for steps created without an explicit canvas position.
 *
 * An open-canvas addition moves down and right until it is clear. An insertion
 * on a downward connection moves the target branch down to open a slot.
 * Positions are canvas coordinates naming a node's top-left corner.
 */

import {
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import {
  GROUP_BOUNDARY_STUB_PORT,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { descendantsOf } from "@wfgraph/shared/graph/descendants";
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

export type InsertionRowPlan = {
  position: { x: number; y: number };
  movedNodes: ReadonlyMap<string, { x: number; y: number }>;
};

/**
 * Open one row where a downward connection reaches its target. The inserted
 * step takes the target's old position, while the target and its downstream
 * cards move together. Sibling branches and horizontal positions stay fixed.
 * Derived boundary stubs follow their anchors when the canvas is projected
 * again. Non-downward connections keep their caller-provided placement.
 */
export function insertionRowPlan(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  sourceId: string,
  targetId: string
): InsertionRowPlan | null {
  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  if (!source || !target || target.position.y <= source.position.y) {
    return null;
  }

  const rowHeight = WORKFLOW_NODE_HEIGHT + RANK_SPACING;
  const movedNodeIds = descendantsOf({ startIds: [targetId], edges });
  movedNodeIds.add(targetId);
  return {
    position: { ...target.position },
    movedNodes: new Map(
      nodes
        .filter(
          (node) =>
            node.type !== "add" &&
            node.data[GROUP_BOUNDARY_STUB_PORT] === undefined &&
            movedNodeIds.has(node.id)
        )
        .map((node) => [
          node.id,
          { x: node.position.x, y: node.position.y + rowHeight },
        ])
    ),
  };
}
