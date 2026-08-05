import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  getSimpleBezierPath,
  type InternalNode,
  Position,
  useInternalNode,
} from "@xyflow/react";
import { getConditionBranchDisplayLabel } from "@rova/shared/conditions/condition-branch";
import type { WorkflowEdge } from "#src/lib/workflow-graph-types";

const Temporary = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps) => {
  const [edgePath] = getSimpleBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <BaseEdge
      className="stroke-1"
      id={id}
      path={edgePath}
      style={{
        stroke: selected ? "var(--muted-foreground)" : "var(--border)",
        strokeDasharray: "5, 5",
      }}
    />
  );
};

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

const getEdgeParams = (
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

const Animated = ({
  id,
  source,
  sourceHandleId,
  target,
  targetHandleId,
  style,
  selected,
  data,
}: EdgeProps<WorkflowEdge>) => {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  if (!(sourceNode && targetNode)) {
    return null;
  }

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(
    sourceNode,
    targetNode,
    sourceHandleId,
    targetHandleId
  );

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
  });
  const branchLabel = getConditionBranchDisplayLabel(sourceHandleId);
  const edgeLabel = branchLabel ?? data?.displayLabel ?? null;
  const inactive = style?.opacity !== undefined;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          stroke: selected ? "var(--muted-foreground)" : "var(--border)",
          strokeWidth: 2,
          strokeDasharray: inactive ? "5, 5" : 5,
          ...(inactive
            ? {}
            : { animation: "dashdraw 0.5s linear infinite" }),
        }}
      />
      {edgeLabel && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded-sm border bg-background px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground leading-none"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              ...(inactive ? { opacity: 0.7 } : {}),
            }}
          >
            {edgeLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
};

export const Edge = {
  Temporary,
  Animated,
};
