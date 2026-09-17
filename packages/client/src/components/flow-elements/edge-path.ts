import { getSmoothStepPath, type InternalNode, Position } from "@xyflow/react";

/**
 * Orthogonal path with rounded corners. `offset` is how far the first segment
 * travels before the turn, so stacked nodes still show a short vertical stub.
 */
const BORDER_RADIUS = 16;
const OFFSET = 16;

type Point = { x: number; y: number };

/**
 * Where a forward edge on a focused Group canvas runs, as `EditorEdgeData`
 * carries it. `turnAlong` is where it turns across the flow into its target's
 * column. `lane`, when present, is a column the edge runs along around the cards
 * in the rows it passes: it turns into that column at `lane.turnAlong` first.
 * `drawn` is the stretch of the path this edge draws, as distances along its
 * corners from the point where it first turns; the rest another edge draws.
 */
export type GroupEdgeRoute = {
  turnAlong?: number | undefined;
  lane?: { across: number; turnAlong: number } | undefined;
  drawn?: { from?: number | undefined; to?: number | undefined } | undefined;
};

/**
 * The corners of a forward edge that turns at `route.turnAlong`, starting at the
 * source and ending at the target, with the distance along those corners from
 * the source to where the edge first turns. Null for any edge that does not run
 * forward from a bottom or right outlet to a top or left inlet with its turns
 * strictly between its ends.
 */
export function routedEdgeCorners(
  input: Pick<
    Parameters<typeof getSmoothStepPath>[0],
    | "sourceX"
    | "sourceY"
    | "sourcePosition"
    | "targetX"
    | "targetY"
    | "targetPosition"
  >,
  route: GroupEdgeRoute | undefined
): { corners: Point[]; turnOffset: number } | null {
  const turnAlong = route?.turnAlong;
  if (turnAlong === undefined) {
    return null;
  }
  const vertical =
    input.sourcePosition === Position.Bottom &&
    input.targetPosition === Position.Top;
  const horizontal =
    input.sourcePosition === Position.Right &&
    input.targetPosition === Position.Left;
  if (!(vertical || horizontal)) {
    return null;
  }
  // Coordinates along and across the flow, turned back into x and y at the end.
  const source = vertical
    ? { along: input.sourceY, across: input.sourceX }
    : { along: input.sourceX, across: input.sourceY };
  const target = vertical
    ? { along: input.targetY, across: input.targetX }
    : { along: input.targetX, across: input.targetY };
  const firstTurn = route?.lane?.turnAlong ?? turnAlong;
  if (
    !(source.along < firstTurn && firstTurn <= turnAlong && turnAlong < target.along)
  ) {
    return null;
  }
  const lane = route?.lane;
  const path = [
    source,
    { along: firstTurn, across: source.across },
    ...(lane
      ? [
          { along: lane.turnAlong, across: lane.across },
          { along: turnAlong, across: lane.across },
        ]
      : []),
    { along: turnAlong, across: target.across },
    target,
  ];
  const corners = path.map((point) =>
    vertical
      ? { x: point.across, y: point.along }
      : { x: point.along, y: point.across }
  );
  return { corners: simplified(corners), turnOffset: firstTurn - source.along };
}

/** `corners` without repeated points or points in the middle of a straight run. */
function simplified(corners: readonly Point[]): Point[] {
  const distinct = corners.filter(
    (point, index) =>
      index === 0 ||
      point.x !== corners[index - 1]?.x ||
      point.y !== corners[index - 1]?.y
  );
  return distinct.filter((point, index) => {
    const before = distinct[index - 1];
    const after = distinct[index + 1];
    return !(
      before &&
      after &&
      ((before.x === point.x && point.x === after.x) ||
        (before.y === point.y && point.y === after.y))
    );
  });
}

const length = (a: Point, b: Point) =>
  Math.abs(b.x - a.x) + Math.abs(b.y - a.y);

/** The point `distance` along the straight run from `a` toward `b`. */
function along(a: Point, b: Point, distance: number): Point {
  const total = length(a, b);
  const t = total === 0 ? 0 : distance / total;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * How far each corner of `corners` rounds, as `getSmoothStepPath` rounds a
 * corner: `BORDER_RADIUS`, or half the shorter run beside it. The two ends take
 * no rounding.
 */
export function cornerRadii(corners: readonly Point[]): number[] {
  return corners.map((point, index) => {
    const before = corners[index - 1];
    const after = corners[index + 1];
    return before && after
      ? Math.min(BORDER_RADIUS, length(before, point) / 2, length(point, after) / 2)
      : 0;
  });
}

/**
 * The SVG path of `corners` with rounded corners, drawing only the stretch from
 * `from` to `to`, both distances along the corners from the first point. A
 * rounded corner is drawn when its middle falls inside the stretch.
 */
function roundedPath(
  corners: readonly Point[],
  from = Number.NEGATIVE_INFINITY,
  to = Number.POSITIVE_INFINITY
): string {
  const radii = cornerRadii(corners);
  const distances = corners.map((_, index) =>
    corners
      .slice(0, index + 1)
      .reduce(
        (total, point, at) =>
          total + (at === 0 ? 0 : length(corners[at - 1] ?? point, point)),
        0
      )
  );
  let path = "";
  const moveOrLine = (point: Point) => {
    path += `${path === "" ? "M" : "L"}${point.x} ${point.y}`;
  };
  corners.forEach((point, index) => {
    const next = corners[index + 1];
    const here = distances[index] ?? 0;
    const radius = radii[index] ?? 0;
    const previous = corners[index - 1];
    if (previous && next && radius > 0 && here >= from && here <= to) {
      const entry = along(point, previous, radius);
      const exit = along(point, next, radius);
      moveOrLine(entry);
      path += `Q ${point.x},${point.y} ${exit.x},${exit.y}`;
    }
    if (!next) {
      return;
    }
    const runStart = here + radius;
    const runEnd = (distances[index + 1] ?? here) - (radii[index + 1] ?? 0);
    const start = Math.max(runStart, from);
    const end = Math.min(runEnd, to);
    if (end - start > 0.01) {
      const startPoint = along(point, next, start - here);
      if (path === "" || start > runStart) {
        path += `M${startPoint.x} ${startPoint.y}`;
      }
      const endPoint = along(point, next, end - here);
      path += `L${endPoint.x} ${endPoint.y}`;
    }
  });
  return path;
}

/**
 * A workflow edge's path, with its label placed where the path turns into its
 * target's column. `route` is the painted edge's routing data.
 */
export function getWorkflowEdgePath(
  input: Parameters<typeof getSmoothStepPath>[0],
  route?: GroupEdgeRoute
): ReturnType<typeof getSmoothStepPath> {
  const routed = routedEdgeCorners(input, route);
  if (!routed) {
    return getSmoothStepPath({
      ...input,
      borderRadius: BORDER_RADIUS,
      offset: OFFSET,
    });
  }
  const { corners } = routed;
  // The label sits in the middle of the run that turns into the target column.
  const last = corners.length - 1;
  const [runStart, runEnd] =
    last >= 3
      ? [corners[last - 2], corners[last - 1]]
      : [corners[0], corners[last]];
  const labelX = ((runStart?.x ?? 0) + (runEnd?.x ?? 0)) / 2;
  const labelY = ((runStart?.y ?? 0) + (runEnd?.y ?? 0)) / 2;
  return [
    roundedPath(corners),
    labelX,
    labelY,
    Math.abs(labelX - input.sourceX),
    Math.abs(labelY - input.sourceY),
  ];
}

/**
 * The part of a routed edge's path the edge draws itself, when `route.drawn`
 * leaves some of it to other edges. Null when the edge draws its whole path.
 */
export function getWorkflowEdgeDrawnPath(
  input: Parameters<typeof getSmoothStepPath>[0],
  route?: GroupEdgeRoute
): string | null {
  const drawn = route?.drawn;
  const routed = routedEdgeCorners(input, route);
  if (!routed || !drawn || (drawn.from === undefined && drawn.to === undefined)) {
    return null;
  }
  return roundedPath(
    routed.corners,
    drawn.from === undefined ? undefined : drawn.from + routed.turnOffset,
    drawn.to === undefined ? undefined : drawn.to + routed.turnOffset
  );
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
