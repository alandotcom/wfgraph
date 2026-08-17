import { getSmoothStepPath, type Position } from "@xyflow/react";

/**
 * Orthogonal path with rounded corners. `offset` is how far the first segment
 * travels before the turn, so stacked nodes still show a short vertical stub.
 */
const BORDER_RADIUS = 16;
const OFFSET = 16;

export function getWorkflowEdgePath(params: {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
}): ReturnType<typeof getSmoothStepPath> {
  return getSmoothStepPath({
    borderRadius: BORDER_RADIUS,
    offset: OFFSET,
    ...params,
  });
}
