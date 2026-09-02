import { getSmoothStepPath } from "@xyflow/react";

/**
 * Orthogonal path with rounded corners. `offset` is how far the first segment
 * travels before the turn, so stacked nodes still show a short vertical stub.
 */
const BORDER_RADIUS = 16;
const OFFSET = 16;

export function getWorkflowEdgePath(
  input: Parameters<typeof getSmoothStepPath>[0]
): ReturnType<typeof getSmoothStepPath> {
  return getSmoothStepPath({
    ...input,
    borderRadius: BORDER_RADIUS,
    offset: OFFSET,
  });
}
