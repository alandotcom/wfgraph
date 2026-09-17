/**
 * Which track each edge crossing one gap between rows of a focused Group turns
 * on. Track 0 is nearest the rows before the gap. Two edges that share neither
 * their source port nor their target port never share a track where their runs
 * across the flow touch, so no two such edges draw over each other. Edges that
 * share a target take one track where they can, so they join once, and so do
 * edges that share a source port, so they fork once.
 */

import { sortBy } from "es-toolkit/array";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

/**
 * One forward edge turning in the gap. `sourcePort` and `targetPort` name the
 * handles it leaves and enters. `from` and `to` are the across-the-flow
 * coordinates of those handles, in canvas pixels.
 */
export type GapEdge = {
  id: string;
  sourcePort: string;
  targetPort: string;
  from: number;
  to: number;
};

/** Coordinates closer than this count as the same column. */
const SAME_COLUMN = 0.5;

const sameColumn = (a: number, b: number) => Math.abs(a - b) < SAME_COLUMN;

const sharesPort = (a: GapEdge, b: GapEdge) =>
  a.sourcePort === b.sourcePort || a.targetPort === b.targetPort;

/**
 * Whether `a` must turn on a track before `b`'s: `a` leaves the column `b`
 * enters, so turning later would draw `a`'s run toward its turn over `b`'s run
 * from its turn into its target.
 */
const mustTurnBefore = (a: GapEdge, b: GapEdge) =>
  !sharesPort(a, b) && sameColumn(a.from, b.to) && !sameColumn(b.from, a.to);

/** Whether `a` and `b` would draw over each other on one track. */
function collides(a: GapEdge, b: GapEdge): boolean {
  if (sharesPort(a, b)) {
    return false;
  }
  const [aLow, aHigh] = [Math.min(a.from, a.to), Math.max(a.from, a.to)];
  const [bLow, bHigh] = [Math.min(b.from, b.to), Math.max(b.from, b.to)];
  // Touching ends collide too: one run would seem to continue into the other.
  return aLow <= bHigh + SAME_COLUMN && bLow <= aHigh + SAME_COLUMN;
}

/**
 * The track of every edge in `edges` that runs across the flow, and how many
 * tracks the gap needs. An edge whose ends share a column runs straight
 * through the gap and takes no track. The answer depends on the edges alone,
 * never on the order they are listed in.
 */
export function assignGapTracks(edges: readonly GapEdge[]): {
  trackOf: Map<string, number>;
  trackCount: number;
} {
  const bent = sortBy(
    edges.filter((edge) => !sameColumn(edge.from, edge.to)),
    [
      (edge) => Math.min(edge.from, edge.to),
      (edge) => Math.max(edge.from, edge.to),
      "id",
    ]
  );
  // Kahn's order over `mustTurnBefore`, taking the earliest listed edge each
  // time; edges caught in a cycle follow in listed order.
  const ordered: GapEdge[] = [];
  const remaining = [...bent];
  while (remaining.length > 0) {
    const index = remaining.findIndex(
      (edge) => !remaining.some((other) => mustTurnBefore(other, edge))
    );
    const [next] = remaining.splice(Math.max(index, 0), 1);
    if (next) {
      ordered.push(next);
    }
  }

  // A Map, because edge ids are chosen by the builder.
  const trackOf = new Map<string, number>();
  for (const edge of ordered) {
    const placed = ordered.filter((other) => trackOf.has(other.id));
    const lowest = Math.max(
      0,
      ...placed
        .filter((other) => mustTurnBefore(other, edge))
        .map((other) => (trackOf.get(other.id) ?? 0) + 1)
    );
    const free = (track: number) =>
      track >= lowest &&
      !placed.some(
        (other) => trackOf.get(other.id) === track && collides(edge, other)
      );
    // Edges into one target join on one track, and edges from one outlet fork
    // on one track, whenever no other edge on that track is in the way.
    const shared = [
      ...placed.filter((other) => other.targetPort === edge.targetPort),
      ...placed.filter((other) => other.sourcePort === edge.sourcePort),
    ].flatMap((other) => {
      const track = trackOf.get(other.id);
      return track === undefined ? [] : [track];
    });
    let track = shared.find(free) ?? lowest;
    while (!free(track)) {
      track += 1;
    }
    trackOf.set(edge.id, track);
  }
  return {
    trackOf,
    trackCount: Math.max(0, ...[...trackOf.values()].map((track) => track + 1)),
  };
}

type Point = { x: number; y: number };

/** One routed edge as its drawing reads it: its ports and its corners. */
export type DrawnEdge = {
  id: string;
  sourcePort: string;
  targetPort: string;
  /** The corners from the source to the target, as `routedEdgeCorners` gives. */
  corners: readonly Point[];
  /** The distance along `corners` from the source to where the edge first turns. */
  turnOffset: number;
};

const runLength = (a: Point, b: Point) =>
  Math.abs(b.x - a.x) + Math.abs(b.y - a.y);

/** Which way a run from `from` to `to` heads, or null when there is no run. */
function heading(from: Point, to: Point | undefined): string | null {
  return to
    ? `${Math.sign(Math.round(to.x - from.x))},${Math.sign(Math.round(to.y - from.y))}`
    : null;
}

/**
 * How far along `p` its rounded path draws over `q`'s, when both start at the
 * same point. The two part where their runs first head different ways, or where
 * they turn the same way with different rounding, less the rounding of the
 * corner either takes there.
 */
function commonLead(
  p: readonly Point[],
  q: readonly Point[],
  radiiP: readonly number[],
  radiiQ: readonly number[]
): number {
  let current = p[0] ?? { x: 0, y: 0 };
  let travelled = 0;
  // The corner of each path `current` stands on, as its index in that path.
  let [i, j] = [0, 0];
  let [atCornerP, atCornerQ] = [false, false];
  for (;;) {
    const radiusP = atCornerP ? (radiiP[i] ?? 0) : 0;
    const radiusQ = atCornerQ ? (radiiQ[j] ?? 0) : 0;
    const nextP = p[i + 1];
    const nextQ = q[j + 1];
    if (!nextP) {
      return travelled;
    }
    if (
      heading(current, nextP) !== heading(current, nextQ) ||
      radiusP !== radiusQ
    ) {
      return travelled - Math.max(radiusP, radiusQ);
    }
    const step = Math.min(
      runLength(current, nextP),
      runLength(current, nextQ ?? nextP)
    );
    current = along(current, nextP, step);
    travelled += step;
    atCornerP = runLength(current, nextP) < SAME_COLUMN;
    atCornerQ = nextQ !== undefined && runLength(current, nextQ) < SAME_COLUMN;
    i += atCornerP ? 1 : 0;
    j += atCornerQ ? 1 : 0;
  }
}

/** The point `distance` along the straight run from `from` toward `to`. */
function along(from: Point, to: Point, distance: number): Point {
  const total = runLength(from, to);
  const t = total === 0 ? 0 : distance / total;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/**
 * The stretch of its path each edge in `edges` draws itself, as distances along
 * its corners from where it first turns, for every edge that leaves part of its
 * path to another. Edges leaving one outlet share the runs they take from it,
 * and edges reaching one target share the runs they take into it. The shorter
 * edge draws a shared run, ties going to the edge id listed first, so each
 * shared run is drawn once and its dashes stay even.
 */
export function drawnStretches(
  edges: readonly DrawnEdge[],
  radii: (corners: readonly Point[]) => number[]
): Map<string, { from?: number; to?: number }> {
  const measured = sortBy(
    edges.map((edge) => ({
      edge,
      radii: radii(edge.corners),
      reversed: edge.corners.toReversed(),
      reversedRadii: radii(edge.corners).toReversed(),
      length: edge.corners
        .slice(1)
        .reduce(
          (total, point, index) =>
            total + runLength(edge.corners[index] ?? point, point),
          0
        ),
    })),
    ["length", (item) => item.edge.id]
  );
  // A Map, because edge ids are chosen by the builder.
  const stretches = new Map<string, { from?: number; to?: number }>();
  measured.forEach((item, index) => {
    const earlier = measured.slice(0, index);
    const leads = earlier
      .filter((other) => other.edge.sourcePort === item.edge.sourcePort)
      .map((other) =>
        commonLead(
          item.edge.corners,
          other.edge.corners,
          item.radii,
          other.radii
        )
      );
    const tails = earlier
      .filter((other) => other.edge.targetPort === item.edge.targetPort)
      .map(
        (other) =>
          item.length -
          commonLead(
            item.reversed,
            other.reversed,
            item.reversedRadii,
            other.reversedRadii
          )
      );
    const from = leads.length > 0 ? Math.max(...leads) : undefined;
    const to = tails.length > 0 ? Math.min(...tails) : undefined;
    if (from === undefined && to === undefined) {
      return;
    }
    stretches.set(
      item.edge.id,
      omitUndefined({
        from: from === undefined ? undefined : from - item.edge.turnOffset,
        to: to === undefined ? undefined : to - item.edge.turnOffset,
      })
    );
  });
  return stretches;
}
