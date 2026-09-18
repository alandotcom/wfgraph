import { getSmoothStepPath, type InternalNode, Position } from "@xyflow/react";

/**
 * Orthogonal path with rounded corners. `offset` is how far the first segment
 * travels before the turn, so stacked nodes still show a short vertical stub.
 */
const BORDER_RADIUS = 16;
const OFFSET = 16;

/**
 * The turn for an edge that runs forward along the flow and crosses at
 * `turnAlong`, a coordinate strictly between its ends on the flow axis. Any
 * other edge gets no turn here, and React Flow turns it halfway.
 */
function turnPoint(
  input: Parameters<typeof getSmoothStepPath>[0],
  turnAlong: number | undefined
): { centerX?: number; centerY?: number } {
  if (turnAlong === undefined) {
    return {};
  }
  const { sourceX, sourceY, targetX, targetY } = input;
  if (
    input.sourcePosition === Position.Bottom &&
    input.targetPosition === Position.Top &&
    sourceY < turnAlong &&
    turnAlong < targetY
  ) {
    return { centerY: turnAlong };
  }
  if (
    input.sourcePosition === Position.Right &&
    input.targetPosition === Position.Left &&
    sourceX < turnAlong &&
    turnAlong < targetX
  ) {
    return { centerX: turnAlong };
  }
  return {};
}

/**
 * A workflow edge's path, with its label placed where the path turns.
 * `options.turnAlong` is the painted edge's `data.turnAlong`.
 */
export function getWorkflowEdgePath(
  input: Parameters<typeof getSmoothStepPath>[0],
  options?: { turnAlong?: number | undefined }
): ReturnType<typeof getSmoothStepPath> {
  return getSmoothStepPath({
    ...turnPoint(input, options?.turnAlong),
    ...input,
    borderRadius: BORDER_RADIUS,
    offset: OFFSET,
  });
}

/**
 * The world coordinates of one handle's outer edge midpoint, and the side of the
 * node the handle sits on. The handle is the one named `handleId`, else the
 * first handle of `handleType` on `fallbackPosition`, else the first handle.
 * Before React Flow measures any handle, the point is the origin on
 * `fallbackPosition`.
 */
const getHandleCoords = (
  node: InternalNode,
  handleType: "source" | "target",
  fallbackPosition: Position,
  handleId?: string | null
): { x: number; y: number; position: Position } => {
  const handles = node.internals.handleBounds?.[handleType];
  const handle =
    (handleId
      ? handles?.find((candidate) => (candidate.id ?? null) === handleId)
      : undefined) ??
    handles?.find((candidate) => candidate.position === fallbackPosition) ??
    handles?.[0];

  if (!handle) {
    return { x: 0, y: 0, position: fallbackPosition };
  }

  const { position } = handle;
  // The handle's own box has its origin at the top left. The edge starts at the
  // middle of the handle's outer side, so the marker at its end stays visible.
  const offset = {
    [Position.Left]: { x: 0, y: handle.height / 2 },
    [Position.Right]: { x: handle.width, y: handle.height / 2 },
    [Position.Top]: { x: handle.width / 2, y: 0 },
    [Position.Bottom]: { x: handle.width / 2, y: handle.height },
  }[position];

  return {
    x: node.internals.positionAbsolute.x + handle.x + offset.x,
    y: node.internals.positionAbsolute.y + handle.y + offset.y,
    position,
  };
};

/**
 * Where a workflow edge starts and ends in world coordinates, and the side of
 * each node its handle sits on. An overview card draws its outlets on the bottom
 * and its inlet on top; a card in a Left to right Group draws them on the right
 * and left. The canvas edge and Canvas Reveal's outlet placement both read it,
 * so the two agree on where a label sits.
 */
export const getEdgeParams = (
  source: InternalNode,
  target: InternalNode,
  sourceHandle?: string | null,
  targetHandle?: string | null
) => {
  const start = getHandleCoords(
    source,
    "source",
    Position.Bottom,
    sourceHandle
  );
  const end = getHandleCoords(target, "target", Position.Top, targetHandle);

  return {
    sx: start.x,
    sy: start.y,
    tx: end.x,
    ty: end.y,
    sourcePos: start.position,
    targetPos: end.position,
  };
};
