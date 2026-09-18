import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  useInternalNode,
} from "@xyflow/react";
import { memo } from "react";
import { resolveEdgeLabel } from "#src/components/flow-elements/edge-label";
import {
  getEdgeParams,
  getWorkflowEdgePath,
} from "#src/components/flow-elements/edge-path";
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

  const [edgePath, labelX, labelY] = getWorkflowEdgePath(
    {
      sourceX: sx,
      sourceY: sy,
      sourcePosition: sourcePos,
      targetX: tx,
      targetY: ty,
      targetPosition: targetPos,
    },
    { turnAlong: data?.turnAlong }
  );
  const edgeLabel = resolveEdgeLabel(sourceHandleId, data);
  // `canvasEdgesAtom` sets this on every edge landing where the run cannot go.
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
          animation:
            inactive || comparison
              ? undefined
              : "dashdraw 0.5s linear infinite",
        }}
      />
      {edgeLabel && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded-sm border bg-background px-1.5 py-0.5 font-medium text-xs text-muted-foreground leading-none"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              opacity: inactive ? 0.7 : undefined,
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
