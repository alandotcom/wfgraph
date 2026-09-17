import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  useInternalNode,
} from "@xyflow/react";
import { createContext, memo, useContext } from "react";
import { resolveEdgeLabel } from "#src/components/flow-elements/edge-label";
import {
  getEdgeParams,
  getWorkflowEdgeDrawnPath,
  getWorkflowEdgePath,
} from "#src/components/flow-elements/edge-path";
import {
  COMPARISON_EDGE_ANNOTATION,
  type ComparisonEdgeAnnotation,
  type WorkflowEdge,
} from "#src/lib/workflow-graph-types";

/**
 * What the + control on a connection does: put a step inside that connection.
 * The canvas fills the slot while inserting steps is offered; null leaves every
 * connection without the control, as a run, a comparison and a phone do.
 */
export const InsertStepSlot = createContext<
  ((input: { edgeId: string }) => void) | null
>(null);

/** The radius of the + control a connection draws, in flow pixels. */
const INSERT_CONTROL_RADIUS = 11;

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
  const insertStepOnEdge = useContext(InsertStepSlot);
  // A painted connection that stands for nothing stored, such as the edge to a
  // "Path ends" stub, takes no control: there is nothing to insert into.
  const insertStep = data?.insertable === false ? null : insertStepOnEdge;

  if (!(sourceNode && targetNode)) {
    return null;
  }

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(
    sourceNode,
    targetNode,
    sourceHandleId,
    targetHandleId
  );

  const pathInput = {
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
  };
  const route = { turnAlong: data?.turnAlong, lane: data?.lane };
  const [edgePath, labelX, labelY] = getWorkflowEdgePath(pathInput, route);
  // A focused Group edge sharing an outlet or a target with another edge draws
  // only its own stretch, so a shared run is drawn once and its dashes stay
  // even. Selected, it draws its whole path over the others.
  const drawnPath = selected
    ? null
    : getWorkflowEdgeDrawnPath(pathInput, { ...route, drawn: data?.drawn });
  const edgeLabel = resolveEdgeLabel(sourceHandleId, data);
  // `canvasEdgesAtom` sets this on every edge landing where the run cannot go.
  const inactive = data?.inactive === true;
  const comparison = data?.[COMPARISON_EDGE_ANNOTATION];
  const comparisonStyle = comparisonEdgeStyle(comparison);

  return (
    <>
      {drawnPath !== null && (
        <path
          className="react-flow__edge-interaction"
          d={edgePath}
          fill="none"
          strokeOpacity={0}
          strokeWidth={20}
        />
      )}
      <BaseEdge
        id={id}
        interactionWidth={drawnPath === null ? 20 : 0}
        path={drawnPath ?? edgePath}
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
      {insertStep && (
        <g
          aria-label="Insert step"
          className="insert-step-control cursor-pointer opacity-0 outline-none transition-opacity duration-150 focus-visible:opacity-100 motion-reduce:transition-none"
          onClick={(event) => {
            event.stopPropagation();
            insertStep({ edgeId: id });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              insertStep({ edgeId: id });
            }
          }}
          role="button"
          tabIndex={0}
          transform={`translate(${labelX}, ${labelY})`}
        >
          <circle
            className="fill-background stroke-border"
            r={INSERT_CONTROL_RADIUS}
            strokeWidth={1}
          />
          <path
            className="stroke-foreground"
            d="M -4 0 H 4 M 0 -4 V 4"
            strokeLinecap="round"
            strokeWidth={1.5}
          />
        </g>
      )}
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
