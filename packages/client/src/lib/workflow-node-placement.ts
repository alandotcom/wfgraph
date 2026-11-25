/**
 * Placement rules for steps created without an explicit canvas position.
 *
 * An open-canvas addition moves down and right until it is clear of every card
 * and connection, with room around each card. An insertion
 * on a downward connection moves the target branch down to open a slot.
 * Positions are canvas coordinates naming a node's top-left corner.
 */

import {
  NODE_SPACING,
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { descendantsOf } from "@wfgraph/shared/graph/descendants";
import {
  offsetClearOfRectangles,
  type NodeRectangle,
} from "@wfgraph/shared/graph/node-placement";

type AbsolutePositionForId = (
  nodeId: string
) => { readonly x: number; readonly y: number } | undefined;

/**
 * How much room a new step keeps from a card already on the canvas: half the
 * gap auto-layout leaves between two siblings, and half the gap between ranks.
 */
const CARD_CLEARANCE = { x: NODE_SPACING / 2, y: RANK_SPACING / 2 };

/**
 * How far either side of a connection's horizontal span its label can reach.
 * A label is centred on that span, and an Event name such as "Appointment
 * rescheduled" draws about 160px wide at caption size.
 */
const EDGE_LABEL_HALF_WIDTH = 80;

/**
 * The space a new step must stay out of: each card grown by
 * `CARD_CLEARANCE`, and the box each connection is drawn in, widened by
 * `EDGE_LABEL_HALF_WIDTH` so the label it may carry counts too. A connection
 * is drawn from the bottom middle of its source to the top middle of its
 * target, so that box spans the two ends.
 */
export function canvasObstacles(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly { source: string; target: string }[];
  absolutePositionForId?: AbsolutePositionForId | undefined;
}): NodeRectangle[] {
  const cards = rectanglesById(
    input.nodes,
    input.absolutePositionForId ?? (() => undefined)
  );
  const grownCards = [...cards.values()].map((card) => ({
    x: card.x - CARD_CLEARANCE.x,
    y: card.y - CARD_CLEARANCE.y,
    width: card.width + 2 * CARD_CLEARANCE.x,
    height: card.height + 2 * CARD_CLEARANCE.y,
  }));
  const corridors = input.edges.flatMap((edge) => {
    const source = cards.get(edge.source);
    const target = cards.get(edge.target);
    if (!source || !target) {
      return [];
    }
    const sourceX = source.x + source.width / 2;
    const targetX = target.x + target.width / 2;
    const sourceBottom = source.y + source.height;
    const left = Math.min(sourceX, targetX) - EDGE_LABEL_HALF_WIDTH;
    const right = Math.max(sourceX, targetX) + EDGE_LABEL_HALF_WIDTH;
    const top = Math.min(sourceBottom, target.y);
    const bottom = Math.max(sourceBottom, target.y);
    return [{ x: left, y: top, width: right - left, height: bottom - top }];
  });
  return [...grownCards, ...corridors];
}

/**
 * Each drawn node's rectangle in canvas space, by node id. React Flow owns the
 * authoritative absolute position after initialization, and the stored parent
 * chain covers a node before that measurement is available. A Map rather than
 * a keyBy record:
 * ids and `parentId` come from the persisted graph, and a plain object would
 * answer a node named `constructor` with a prototype member.
 */
function rectanglesById(
  nodes: readonly WorkflowNode[],
  absolutePositionForId: AbsolutePositionForId
): Map<string, NodeRectangle> {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  return new Map(
    nodes
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

        return [
          node.id,
          {
            x,
            y,
            width: node.measured?.width ?? node.width ?? WORKFLOW_NODE_WIDTH,
            height:
              node.measured?.height ?? node.height ?? WORKFLOW_NODE_HEIGHT,
          },
        ] as const;
      })
  );
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
 * Non-downward connections keep their caller-provided placement. `nodes` are
 * in one coordinate space, as `canvasPlacementNodes` gives them.
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
        .filter((node) => node.type !== "add" && movedNodeIds.has(node.id))
        .map((node) => [
          node.id,
          { x: node.position.x, y: node.position.y + rowHeight },
        ])
    ),
  };
}
