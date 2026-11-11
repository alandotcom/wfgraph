/**
 * Where a step an authoring tool just added goes, given a graph a person may
 * already have arranged by hand.
 *
 * `layoutWorkflowNodes` re-places every node, which is right for a graph no
 * one has arranged and wrong for one someone has. This places only the nodes
 * the caller names as unplaced, each next to a neighbour that already has a
 * position: below the step it runs after, or above the step it leads to, and
 * moved right until it overlaps nothing. Every other node keeps its position.
 * A graph with no positioned node at all is laid out whole.
 */

import type { ExtensionCatalog } from "#src/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { layoutWorkflowNodes } from "#src/graph/workflow-layout";
import {
  NODE_SPACING,
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/graph/workflow-layout-geometry";

type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** The margin two placed cards keep between them, on every side. */
const CLEARANCE = 24;

/** The most slots one node tries before it settles where it is. */
const MAX_SHIFTS = 200;

function boxOf(node: WorkflowNode, position = node.position): Box {
  return {
    ...position,
    width: node.width ?? WORKFLOW_NODE_WIDTH,
    height: node.height ?? WORKFLOW_NODE_HEIGHT,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width + CLEARANCE &&
    b.x < a.x + a.width + CLEARANCE &&
    a.y < b.y + b.height + CLEARANCE &&
    b.y < a.y + a.height + CLEARANCE
  );
}

/** Whether a node sits at the origin, where a tool leaves one it added. */
function atOrigin(node: WorkflowNode): boolean {
  return node.position.x === 0 && node.position.y === 0;
}

/** A node that auto-layout places: not the editor's add placeholder. */
function isPlaceable(node: WorkflowNode): boolean {
  return node.type !== "add";
}

/**
 * Places each node `unplacedIds` names beside its neighbours, and leaves every
 * other node where it is. When no other node has a position off the origin,
 * the whole graph is laid out instead.
 */
export function placeNewWorkflowNodes<TNode extends WorkflowNode>(input: {
  readonly nodes: TNode[];
  readonly edges: WorkflowEdge[];
  readonly catalog: ExtensionCatalog;
  readonly unplacedIds: ReadonlySet<string>;
}): TNode[] {
  const placeable = input.nodes.filter(isPlaceable);
  const unplaced = placeable.filter((node) => input.unplacedIds.has(node.id));
  if (unplaced.length === 0) {
    return input.nodes;
  }
  const arranged = placeable.filter(
    (node) => !input.unplacedIds.has(node.id) && !atOrigin(node)
  );
  if (arranged.length === 0) {
    return layoutWorkflowNodes({
      nodes: input.nodes,
      edges: input.edges,
      catalog: input.catalog,
    }).nodes;
  }

  const byId = new Map(input.nodes.map((node) => [node.id, node] as const));
  const positions = new Map(
    input.nodes
      .filter((node) => !input.unplacedIds.has(node.id))
      .map((node) => [node.id, node.position] as const)
  );

  /** The boxes already placed in one coordinate space: one Group, or none. */
  const boxesIn = (parentId: string | undefined): Box[] =>
    input.nodes.flatMap((node) => {
      const position = positions.get(node.id);
      return position !== undefined &&
        node.parentId === parentId &&
        isPlaceable(node)
        ? [boxOf(node, position)]
        : [];
    });

  /** The first slot right of `start` that overlaps no placed box. */
  const freeSlot = (node: TNode, start: { x: number; y: number }) => {
    const taken = boxesIn(node.parentId);
    let candidate = boxOf(node, start);
    for (
      let shift = 0;
      shift < MAX_SHIFTS && taken.some((box) => overlaps(candidate, box));
      shift++
    ) {
      candidate = {
        ...candidate,
        x: candidate.x + candidate.width + NODE_SPACING,
      };
    }
    return { x: candidate.x, y: candidate.y };
  };

  /** A placed neighbour in the same coordinate space as `node`. */
  const placedNeighbour = (node: TNode, nodeId: string) => {
    const neighbour = byId.get(nodeId);
    const position = positions.get(nodeId);
    return neighbour && position && neighbour.parentId === node.parentId
      ? boxOf(neighbour, position)
      : undefined;
  };

  // A node whose neighbour is itself new waits for it, so a chain of new
  // steps is placed from the end that touches the arranged graph.
  let pending = unplaced;
  while (pending.length > 0) {
    const waiting: TNode[] = [];
    for (const node of pending) {
      const above = input.edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => placedNeighbour(node, edge.source))
        .find((box) => box !== undefined);
      const below = input.edges
        .filter((edge) => edge.source === node.id)
        .map((edge) => placedNeighbour(node, edge.target))
        .find((box) => box !== undefined);
      const height = boxOf(node).height;
      if (above) {
        positions.set(
          node.id,
          freeSlot(node, {
            x: above.x,
            y: above.y + above.height + RANK_SPACING,
          })
        );
      } else if (below) {
        positions.set(
          node.id,
          freeSlot(node, { x: below.x, y: below.y - height - RANK_SPACING })
        );
      } else {
        waiting.push(node);
      }
    }

    if (waiting.length === pending.length) {
      // Nothing left touches a placed node: start the rest below everything.
      const [first, ...rest] = waiting;
      if (first === undefined) {
        break;
      }
      const space = boxesIn(first.parentId);
      positions.set(
        first.id,
        freeSlot(first, {
          x: Math.min(...space.map((box) => box.x), 0),
          y:
            Math.max(...space.map((box) => box.y + box.height), 0) +
            RANK_SPACING,
        })
      );
      pending = rest;
    } else {
      pending = waiting;
    }
  }

  return input.nodes.map((node) => {
    const position = positions.get(node.id);
    return input.unplacedIds.has(node.id) && position !== undefined
      ? { ...node, position }
      : node;
  });
}
