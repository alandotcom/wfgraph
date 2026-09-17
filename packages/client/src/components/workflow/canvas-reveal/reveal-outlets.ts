/**
 * What Canvas Reveal keeps in view for a node with labelled outlets, in world
 * coordinates: the node with its source handles, which set the zoom, and the
 * label drawn on each edge leaving by a named outlet, which the camera adds
 * only while it fits. Before React Flow measures the handles, the node is alone.
 */

import type { InternalNode } from "@xyflow/react";
import {
  getEdgeParams,
  getWorkflowEdgePath,
} from "#src/components/flow-elements/edge-path";
import type { EditorEdgeData } from "#src/lib/workflow-graph-types";
import type { Rect } from "./reveal-geometry";

/**
 * A box at least as large as the outlet label the canvas draws at an edge's
 * midpoint ("True" or "False" in Caption type with its padding and border).
 */
export const OUTLET_LABEL_SIZE = { width: 56, height: 24 } as const;

/** An edge as React Flow holds it, reduced to what locates its label. */
export type OutletEdge = {
  source: string;
  target: string;
  sourceHandle?: string | null | undefined;
  targetHandle?: string | null | undefined;
  data?: Pick<EditorEdgeData, "turnAlong" | "lane"> | undefined;
};

function union(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * `bounds` is `nodeBounds` grown to hold the outlet handles of `nodeId`, and
 * `labels` holds one box per edge leaving it by a named outlet, in edge order.
 * An edge is skipped while React Flow holds no measured target handle for it,
 * since its label has no place yet.
 */
export function outletPlacement(input: {
  nodeId: string;
  nodeBounds: Rect;
  edges: readonly OutletEdge[];
  getInternalNode: (id: string) => InternalNode | undefined;
}): { bounds: Rect; labels: Rect[] } {
  const node = input.getInternalNode(input.nodeId);
  const handles = node?.internals.handleBounds?.source;
  if (!node || !handles || handles.length === 0) {
    return { bounds: input.nodeBounds, labels: [] };
  }
  const origin = node.internals.positionAbsolute;
  const handleRects = handles.map((handle) => ({
    x: origin.x + handle.x,
    y: origin.y + handle.y,
    width: handle.width,
    height: handle.height,
  }));
  const labels = input.edges.flatMap((edge) => {
    const target =
      edge.source === input.nodeId && edge.sourceHandle
        ? input.getInternalNode(edge.target)
        : undefined;
    if (!target?.internals.handleBounds?.target?.length) {
      return [];
    }
    const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(
      node,
      target,
      edge.sourceHandle,
      edge.targetHandle
    );
    const [, labelX, labelY] = getWorkflowEdgePath(
      {
        sourceX: sx,
        sourceY: sy,
        sourcePosition: sourcePos,
        targetX: tx,
        targetY: ty,
        targetPosition: targetPos,
      },
      { turnAlong: edge.data?.turnAlong, lane: edge.data?.lane }
    );
    return [
      {
        x: labelX - OUTLET_LABEL_SIZE.width / 2,
        y: labelY - OUTLET_LABEL_SIZE.height / 2,
        ...OUTLET_LABEL_SIZE,
      },
    ];
  });
  return { bounds: union([input.nodeBounds, ...handleRects]), labels };
}
