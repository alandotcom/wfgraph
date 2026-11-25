import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  useInternalNode,
} from "@xyflow/react";
import { useAtomValue } from "jotai";
import { createContext, memo, useContext } from "react";
import { cn } from "@wfgraph/shared/utils";
import { resolveEdgeLabel } from "#src/components/flow-elements/edge-label";
import { useCompactCard } from "#src/components/flow-elements/node";
import {
  bendAboveHeaders,
  crossedRegionHeaders,
  type FlowRect,
  getEdgeParams,
  getWorkflowEdgePath,
} from "#src/components/flow-elements/edge-path";
import {
  RunPathCaptionText,
  runPathCaptionClass,
} from "#src/components/workflow/nodes/outlet-label";
import {
  COMPARISON_EDGE_ANNOTATION,
  type ComparisonEdgeAnnotation,
  type WorkflowEdge,
} from "#src/lib/workflow-graph-types";
import { isLiveRunCanvasAtom } from "#src/lib/workflow-graph-store";

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

/**
 * `px` flow pixels, and never under `px` pixels on screen while the canvas is
 * zoomed out, read from the `--rf-zoom` the canvas publishes. A wire 2px wide
 * on screen always covers a whole pixel, so it reads at Canvas Line's own
 * contrast at every zoom.
 */
export function heldOnScreen(px: number): string {
  return `max(${px}px, calc(${px}px / var(--rf-zoom, 1)))`;
}

/** A dash pattern such as "7, 4", with each length held like `heldOnScreen`. */
export function heldDashes(pattern: string): string {
  return pattern === "none"
    ? pattern
    : pattern
        .split(",")
        .map((length) => heldOnScreen(Number(length.trim())))
        .join(", ");
}

/** A node's box in flow coordinates, once React Flow has measured it. */
function flowBox(node: {
  internals: { positionAbsolute: { x: number; y: number } };
  measured: { width?: number | undefined; height?: number | undefined };
}): FlowRect | undefined {
  const { width, height } = node.measured;
  return width === undefined || height === undefined
    ? undefined
    : { ...node.internals.positionAbsolute, width, height };
}

/** How far past a connection's two ends its mask reaches, in flow pixels. */
const MASK_MARGIN = 64;

/**
 * Hides a connection's stroke inside `bands`, so it reads as passing under a
 * Group region's header. The mask covers the connection's ends with
 * `MASK_MARGIN` to spare, which holds the bends of its rounded path.
 */
function HeaderBandMask({
  id,
  bands,
  from,
  to,
}: {
  id: string;
  bands: readonly FlowRect[];
  from: { x: number; y: number };
  to: { x: number; y: number };
}) {
  const x = Math.min(from.x, to.x) - MASK_MARGIN;
  const y = Math.min(from.y, to.y) - MASK_MARGIN;
  const width = Math.abs(from.x - to.x) + 2 * MASK_MARGIN;
  const height = Math.abs(from.y - to.y) + 2 * MASK_MARGIN;
  return (
    <mask
      height={height}
      id={id}
      maskUnits="userSpaceOnUse"
      width={width}
      x={x}
      y={y}
    >
      <rect fill="white" height={height} width={width} x={x} y={y} />
      {bands.map((band) => (
        <rect
          fill="black"
          height={band.height}
          key={`${band.x}:${band.y}`}
          width={band.width}
          x={band.x}
          y={band.y}
        />
      ))}
    </mask>
  );
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
  // The Group regions the two ends stand in, whose header bands the
  // connection must not draw across.
  const sourceRegion = useInternalNode(sourceNode?.parentId ?? "");
  const targetRegion = useInternalNode(targetNode?.parentId ?? "");
  const insertStepOnEdge = useContext(InsertStepSlot);
  const liveRun = useAtomValue(isLiveRunCanvasAtom);
  // While cards are compact a connection draws no caption: at its 12px it
  // would draw at 6px when the whole workflow is fitted, and the outline
  // names every outlet in words.
  const isCompact = useCompactCard();


  if (!(sourceNode && targetNode)) {
    return null;
  }

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(
    sourceNode,
    targetNode,
    sourceHandleId,
    targetHandleId
  );

  // A connection into or out of a Group region passes under the region's
  // header, so the Group's name and marks are never struck through, and makes
  // its horizontal run above the header rather than under it.
  const headerBands = crossedRegionHeaders({
    sourceRegionId: sourceNode.parentId,
    targetRegionId: targetNode.parentId,
    regionBox: (regionId) =>
      regionId === sourceRegion?.id
        ? flowBox(sourceRegion)
        : regionId === targetRegion?.id
          ? flowBox(targetRegion)
          : undefined,
  });
  const pathInput = {
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
    centerY: bendAboveHeaders({ sourceY: sy, targetY: ty, bands: headerBands }),
  };
  const [edgePath, labelX, labelY] = getWorkflowEdgePath(pathInput);
  const maskId = headerBands.length > 0 ? `edge-header-mask-${id}` : null;
  const edgeLabel = resolveEdgeLabel(sourceHandleId, data);
  // `canvasEdgesAtom` sets `inactive` on every edge landing where the run
  // cannot go, and on a run's canvas `runPath` on every edge the run decided.
  // An edge the run did not take reads the same as one it cannot reach.
  const runPath = data?.runPath;
  const inactive = data?.inactive === true || runPath === "not-taken";
  const taken = runPath === "taken" && !inactive;
  // The dash marches only on the canvas of a run in progress, along a
  // connection the run may still take. Everywhere else the wire holds still.
  const marches = liveRun && runPath === undefined && !inactive;
  const captionMark = taken ? "taken" : runPath === "not-taken" ? runPath : null;
  const comparison = data?.[COMPARISON_EDGE_ANNOTATION];
  const comparisonStyle = comparisonEdgeStyle(comparison);

  return (
    <>
      {maskId ? (
        <HeaderBandMask
          bands={headerBands}
          from={{ x: sx, y: sy }}
          id={maskId}
          to={{ x: tx, y: ty }}
        />
      ) : null}
      <BaseEdge
        id={id}
        interactionWidth={20}
        mask={maskId ? `url(#${maskId})` : undefined}
        path={edgePath}
        style={{
          ...style,
          // Selection outranks inactivity, because an inactive edge is still
          // selectable and deletable and has to show what Delete would take.
          // Inactive is then said by the wider dash gap rather than by fading
          // the wire toward the background. A taken edge is a solid Graphite
          // Ink line, so the path a run took reads by its unbroken stroke as
          // well as its tone.
          ...comparisonStyle,
          stroke:
            selected || taken
              ? "var(--primary)"
              : inactive
                ? "var(--canvas-line-muted)"
                : (comparisonStyle.stroke ?? "var(--canvas-line)"),
          strokeWidth: heldOnScreen(comparisonStyle.strokeWidth ?? 2),
          strokeDasharray: heldDashes(
            comparisonStyle.strokeDasharray ??
              (taken ? "none" : inactive ? "4, 8" : "5")
          ),
          animation: marches ? "dashdraw 0.5s linear infinite" : undefined,
        }}
      />
      {insertStepOnEdge && (
        <g
          aria-label="Insert step"
          className="insert-step-control cursor-pointer opacity-0 outline-none transition-opacity duration-150 focus-visible:opacity-100 motion-reduce:transition-none"
          onClick={(event) => {
            event.stopPropagation();
            insertStepOnEdge({ edgeId: id });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              insertStepOnEdge({ edgeId: id });
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
      {edgeLabel && !isCompact && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "pointer-events-none absolute rounded-sm border bg-background px-1.5 py-0.5 font-medium text-xs text-muted-foreground leading-none",
              runPathCaptionClass(captionMark)
            )}
            data-run-path={runPath}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              opacity: data?.inactive === true ? 0.7 : undefined,
            }}
          >
            <RunPathCaptionText mark={captionMark}>
              {edgeLabel}
            </RunPathCaptionText>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const Edge = {
  Animated,
};
