import { getSmoothStepPath, type InternalNode, Position } from "@xyflow/react";

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

const getHandleCoordsByPosition = (
  node: InternalNode,
  handleType: "source" | "target",
  handlePosition: Position,
  handleId?: string | null
) => {
  const handles = node.internals.handleBounds?.[handleType];
  if (!(handles && handles.length > 0)) {
    return [0, 0] as const;
  }

  const handle =
    (handleId
      ? handles.find((candidate) => (candidate.id ?? null) === handleId)
      : undefined) ??
    handles.find((candidate) => candidate.position === handlePosition) ??
    handles[0];

  if (!handle) {
    return [0, 0] as const;
  }

  let offsetX = handle.width / 2;
  let offsetY = handle.height / 2;

  // this is a tiny detail to make the markerEnd of an edge visible.
  // The handle position that gets calculated has the origin top-left, so depending which side we are using, we add a little offset
  // when the handlePosition is Position.Right for example, we need to add an offset as big as the handle itself in order to get the correct position
  switch (handlePosition) {
    case Position.Left:
      offsetX = 0;
      break;
    case Position.Right:
      offsetX = handle.width;
      break;
    case Position.Top:
      offsetY = 0;
      break;
    case Position.Bottom:
      offsetY = handle.height;
      break;
    default:
      throw new Error("Invalid handle position");
  }

  const x = node.internals.positionAbsolute.x + handle.x + offsetX;
  const y = node.internals.positionAbsolute.y + handle.y + offsetY;

  return [x, y] as const;
};

/**
 * Where a workflow edge starts and ends in world coordinates: the bottom of the
 * source handle and the top of the target handle. The canvas edge and Canvas
 * Reveal's outlet placement both read it, so the two agree on where a label sits.
 */
export const getEdgeParams = (
  source: InternalNode,
  target: InternalNode,
  sourceHandle?: string | null,
  targetHandle?: string | null
) => {
  const sourcePos = Position.Bottom;
  const [sx, sy] = getHandleCoordsByPosition(
    source,
    "source",
    sourcePos,
    sourceHandle
  );
  const targetPos = Position.Top;
  const [tx, ty] = getHandleCoordsByPosition(
    target,
    "target",
    targetPos,
    targetHandle
  );

  return {
    sx,
    sy,
    tx,
    ty,
    sourcePos,
    targetPos,
  };
};
