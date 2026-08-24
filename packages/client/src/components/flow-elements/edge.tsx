import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  type InternalNode,
  Position,
  useInternalNode,
} from "@xyflow/react";
import { memo } from "react";
import { resolveEdgeLabel } from "#src/components/flow-elements/edge-label";
import { getWorkflowEdgePath } from "#src/components/flow-elements/edge-path";
import {
  COMPARISON_EDGE_ANNOTATION,
  type ComparisonEdgeAnnotation,
  type WorkflowEdge,
} from "#src/lib/workflow-graph-types";

export function comparisonEdgeStyle(
  comparison: ComparisonEdgeAnnotation | undefined
): { stroke?: string; strokeDasharray?: string; strokeWidth?: number } {
  switch (comparison?.kind) {
    case "added":
      return {
        stroke: "var(--success)",
        strokeDasharray: "7, 4",
        strokeWidth: 2.5,
      };
    case "removed":
      return {
        stroke: "var(--destructive)",
        strokeDasharray: "2, 5",
        strokeWidth: 2.5,
      };
    default:
      return {};
  }
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

const Animated = memo(function Animated({
  id,
  source,
  sourceHandleId,
  target,
  targetHandleId,
  style,
  selected,
  data,
}: EdgeProps<WorkflowEdge>) {
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

  const [edgePath, labelX, labelY] = getWorkflowEdgePath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
  });
  const edgeLabel = resolveEdgeLabel(sourceHandleId, data);
  // `displayEdgesAtom` sets this on every edge landing where the run cannot go.
  const inactive = data?.inactive === true;
  const comparison = data?.[COMPARISON_EDGE_ANNOTATION];
  const comparisonStyle = comparisonEdgeStyle(comparison);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          // Selection outranks inactivity, because an inactive edge is still
          // selectable and deletable and has to show what Delete would take.
          // Inactive is then said by the wider gap and the stopped march below,
          // rather than by fading the wire toward the background.
          ...comparisonStyle,
          stroke: selected
            ? "var(--primary)"
            : inactive
              ? "var(--canvas-line-muted)"
              : (comparisonStyle.stroke ?? "var(--canvas-line)"),
          strokeWidth: comparisonStyle.strokeWidth ?? 2,
          strokeDasharray:
            comparisonStyle.strokeDasharray ?? (inactive ? "4, 8" : "5"),
          ...(inactive || comparison
            ? {}
            : { animation: "dashdraw 0.5s linear infinite" }),
        }}
      />
      {edgeLabel && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded-sm border bg-background px-1.5 py-0.5 font-medium text-xs text-muted-foreground leading-none"
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
});

export const Edge = {
  Animated,
};
