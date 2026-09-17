/**
 * Where the edges of a focused Group run: which gap each one turns across, the
 * lane it takes past the rows between its ends, and the stretch of its path it
 * draws itself. The rows and the cards come from `group-scope-canvas.ts`, which
 * paints what these answers describe.
 */

import { sortBy, uniq } from "es-toolkit/array";
import { mean } from "es-toolkit/math";
import { groupPortKey } from "@wfgraph/shared/graph/group-port-key";
import { normalizeConditionBranch } from "@wfgraph/shared/conditions/condition-branch";
import type { GroupLayoutDirection } from "@wfgraph/shared/graph/schemas";
import { assignGapTracks } from "#src/lib/group-edge-tracks";
import {
  CONDITION_OUTLET_FRACTION,
  NODE_SPACING,
  RANK_SPACING,
} from "#src/lib/workflow-node-dimensions";

/** A painted node's box, before it becomes a React Flow node. */
export type PaintedBox = {
  position: { x: number; y: number };
  width: number;
  height: number;
  /** True for a member Condition, whose True and False outlets sit apart. */
  condition: boolean;
};

/** A painted edge as routing reads it. */
export type RoutedEdge = {
  id: string;
  source: string;
  sourceHandle?: string | null | undefined;
  target: string;
};

/**
 * The narrowest distance between two tracks in one gap, between a track and the
 * rows on either side of the gap, and between an edge running past a row and a
 * card or another edge in that row. A gap needing more tracks than
 * `RANK_SPACING` holds at this distance grows.
 */
export const TRACK_SPACING = 20;

/**
 * Where an edge runs past a row with no card beside it: this far from the card
 * it clears, which is the middle of the space between two cards a column apart.
 */
const LANE_OFFSET = NODE_SPACING / 2;

/**
 * Where the outlet `handle` of `box` sits across the flow: a Condition's True
 * and False outlets where its card draws them, and every other outlet in the
 * middle of its side.
 */
export function outletAcross(
  box: PaintedBox,
  handle: string | null | undefined,
  direction: GroupLayoutDirection
): number {
  const branch = box.condition ? normalizeConditionBranch(handle) : null;
  const fraction =
    branch === "true" || branch === "false"
      ? CONDITION_OUTLET_FRACTION[branch]
      : 0.5;
  return direction === "vertical"
    ? box.position.x + box.width * fraction
    : box.position.y + box.height * fraction;
}

/** A painted edge's route, as `EditorEdgeData` carries it. */
export type PaintedRoute = {
  turnAlong: number;
  lane?: { across: number; turnAlong: number } | undefined;
  drawn?: { from?: number | undefined; to?: number | undefined } | undefined;
};

/** One run of an edge across a gap between two rows. */
type GapRun = {
  id: string;
  sourcePort: string;
  targetPort: string;
  from: number;
  to: number;
};

/**
 * The column across the flow an edge from `from` to `to` runs along past rows
 * whose cards and runs leave only the spaces outside `blocked`: the middle of a
 * space between two blocked spans, or `LANE_OFFSET` past the outermost card,
 * whichever is nearest both ends. A tie goes to the side farther from `middle`,
 * so a lane passes outside the Group before it passes between its cards.
 */
function laneAcross(input: {
  blocked: readonly { low: number; high: number }[];
  from: number;
  to: number;
  middle: number;
}): number {
  const merged = sortBy(input.blocked, ["low"]).reduce<
    { low: number; high: number }[]
  >((spans, span) => {
    const last = spans.at(-1);
    if (last && span.low <= last.high) {
      last.high = Math.max(last.high, span.high);
      return spans;
    }
    return [...spans, { ...span }];
  }, []);
  const first = merged[0];
  const last = merged.at(-1);
  if (!first || !last) {
    return input.from;
  }
  const clearance = LANE_OFFSET - TRACK_SPACING;
  const candidates = [
    first.low - clearance,
    ...merged.slice(1).flatMap((span, index) => {
      const before = merged[index];
      return before ? [(before.high + span.low) / 2] : [];
    }),
    last.high + clearance,
  ];
  const ranked = sortBy(
    candidates.map((across) => ({
      across,
      distance: Math.abs(across - input.from) + Math.abs(across - input.to),
      inside: -Math.abs(across - input.middle),
    })),
    ["distance", "inside", "across"]
  );
  return ranked[0]?.across ?? input.from;
}

/** The outlet and target a run past a row belongs to. */
function ownerOf(item: { sourcePort: string; targetPort: string }): {
  port: string;
  target: string;
} {
  return { port: item.sourcePort, target: item.targetPort };
}

/** The rows an edge from `sourceRow` to `targetRow` passes between its ends. */
function passedRows(item: { sourceRow: number; targetRow: number }): number[] {
  return Array.from(
    { length: Math.max(0, item.targetRow - item.sourceRow - 1) },
    (_, index) => item.sourceRow + 1 + index
  );
}

/** The id of the run an edge takes across a gap into its lane. */
function laneRunId(edgeId: string): string {
  return `${edgeId}\0lane`;
}

/**
 * Where every box moves along the flow, and how each forward edge runs. Boxes
 * sharing a start along the flow form one row. An edge turns into its target's
 * column in the gap that ends where its target's row starts. An edge that passes
 * rows runs straight down its source's column when no card or other edge in
 * those rows is in the way, and otherwise turns in the gap after its source's
 * row into a lane `laneAcross` finds, runs along it past those rows, and turns
 * into its target's column. The runs turning in one gap take tracks from
 * `assignGapTracks`, spread evenly across the gap, and a gap too narrow for its
 * tracks grows by moving every later row, while the first member row keeps its
 * place. An edge whose target starts before its source ends gets no route, so a
 * backward or same-row edge keeps React Flow's routing.
 */
export function routeFocusedGroup(input: {
  boxes: ReadonlyMap<string, PaintedBox>;
  edges: readonly RoutedEdge[];
  firstMemberId: string;
  direction: GroupLayoutDirection;
}): {
  shift: (id: string) => number;
  routeOf: (edgeId: string) => PaintedRoute | undefined;
} {
  const vertical = input.direction === "vertical";
  const startOf = (box: PaintedBox) =>
    vertical ? box.position.y : box.position.x;
  const endOf = (box: PaintedBox) =>
    startOf(box) + (vertical ? box.height : box.width);
  const acrossSpan = (box: PaintedBox) => {
    const low = vertical ? box.position.x : box.position.y;
    return { low, high: low + (vertical ? box.width : box.height) };
  };
  const boxes = [...input.boxes.values()];
  const rowStarts = uniq(boxes.map(startOf)).toSorted((a, b) => a - b);
  const rowOf = (box: PaintedBox) => rowStarts.indexOf(startOf(box));
  const middle = mean(
    boxes.map((box) => {
      const span = acrossSpan(box);
      return (span.low + span.high) / 2;
    })
  );

  const forward = sortBy(
    input.edges.flatMap((edge) => {
      const source = input.boxes.get(edge.source);
      const target = input.boxes.get(edge.target);
      return source && target && endOf(source) <= startOf(target)
        ? [
            {
              edge,
              sourceRow: rowOf(source),
              targetRow: rowOf(target),
              sourcePort: groupPortKey({
                nodeId: edge.source,
                handle: edge.sourceHandle ?? null,
              }),
              targetPort: edge.target,
              from: outletAcross(source, edge.sourceHandle, input.direction),
              to: outletAcross(target, null, input.direction),
            },
          ]
        : [];
    }),
    ["sourceRow", "targetRow", "from", (item) => item.edge.id]
  );

  // The runs passing each row: a card's span, widened by `TRACK_SPACING`, and
  // each edge run already routed past the row with the outlet it leaves.
  const passing = new Map<
    number,
    { across: number; port: string; target: string }[]
  >();
  const cardsIn = (row: number) =>
    boxes
      .filter((box) => rowOf(box) === row)
      .map((box) => {
        const span = acrossSpan(box);
        return {
          low: span.low - TRACK_SPACING,
          high: span.high + TRACK_SPACING,
        };
      });
  // Runs leaving the same outlet, or reaching the same target, may share a
  // column: they draw as one line that forks or joins.
  const runsIn = (row: number, owner: { port: string; target: string }) =>
    (passing.get(row) ?? [])
      .filter((run) => run.port !== owner.port && run.target !== owner.target)
      .map((run) => ({
        low: run.across - TRACK_SPACING,
        high: run.across + TRACK_SPACING,
      }));
  const isClear = (
    across: number,
    rows: readonly number[],
    owner: { port: string; target: string }
  ) =>
    rows.every((row) =>
      [...cardsIn(row), ...runsIn(row, owner)].every(
        (span) => across <= span.low || across >= span.high
      )
    );
  const reserve = (
    across: number,
    rows: readonly number[],
    owner: { port: string; target: string }
  ) => {
    for (const row of rows) {
      passing.set(row, [...(passing.get(row) ?? []), { across, ...owner }]);
    }
  };

  // Edges whose own column is clear take it first, so a lane found later keeps
  // clear of them.
  const lanes = new Map<string, number>();
  const passes = forward.filter((item) => passedRows(item).length > 0);
  const detoured = passes.filter((item) => {
    const rows = passedRows(item);
    if (isClear(item.from, rows, ownerOf(item))) {
      reserve(item.from, rows, ownerOf(item));
      return false;
    }
    return true;
  });
  for (const item of detoured) {
    const rows = passedRows(item);
    const across = laneAcross({
      blocked: rows.flatMap((row) => [
        ...cardsIn(row),
        ...runsIn(row, ownerOf(item)),
      ]),
      from: item.from,
      to: item.to,
      middle,
    });
    lanes.set(item.edge.id, across);
    reserve(across, rows, ownerOf(item));
  }

  const runs = forward.flatMap((item): { gap: number; run: GapRun }[] => {
    const lane = lanes.get(item.edge.id);
    if (lane === undefined) {
      return [
        {
          gap: item.targetRow,
          run: {
            id: item.edge.id,
            sourcePort: item.sourcePort,
            targetPort: item.targetPort,
            from: item.from,
            to: item.to,
          },
        },
      ];
    }
    const lanePort = laneRunId(item.edge.id);
    return [
      {
        gap: item.sourceRow + 1,
        run: {
          id: lanePort,
          sourcePort: item.sourcePort,
          // Runs into one lane toward one target meet on one track.
          targetPort: `${item.targetPort}\0lane:${lane}`,
          from: item.from,
          to: lane,
        },
      },
      {
        gap: item.targetRow,
        run: {
          id: item.edge.id,
          sourcePort: lanePort,
          targetPort: item.targetPort,
          from: lane,
          to: item.to,
        },
      },
    ];
  });
  const gaps = Map.groupBy(runs, (item) => item.gap);
  const tracks = new Map(
    [...gaps].map(([gap, items]) => [
      gap,
      assignGapTracks(items.map((item) => item.run)),
    ])
  );
  const growthOf = (row: number) =>
    Math.max(
      0,
      ((tracks.get(row)?.trackCount ?? 0) + 1) * TRACK_SPACING - RANK_SPACING
    );
  // `growthBefore[row]` is how far the gaps up to `row` grew in total.
  const growthBefore = rowStarts.map((_, row) =>
    Array.from({ length: row + 1 }, (_unused, gap) => growthOf(gap)).reduce(
      (total, value) => total + value,
      0
    )
  );
  const firstMember = input.boxes.get(input.firstMemberId);
  const anchorGrowth = firstMember
    ? (growthBefore[rowOf(firstMember)] ?? 0)
    : 0;
  const shiftOfRow = (row: number) => (growthBefore[row] ?? 0) - anchorGrowth;
  const shift = (id: string) => {
    const box = input.boxes.get(id);
    return box ? shiftOfRow(rowOf(box)) : 0;
  };

  const turnIn = (gap: number, runId: string) => {
    const gapEnd = (rowStarts[gap] ?? 0) + shiftOfRow(gap);
    const gapStart =
      Math.max(
        ...boxes.filter((box) => rowOf(box) < gap).map((box) => endOf(box))
      ) + shiftOfRow(gap - 1);
    const assigned = tracks.get(gap);
    const track = assigned?.trackOf.get(runId);
    const fraction =
      assigned && track !== undefined
        ? (track + 1) / (assigned.trackCount + 1)
        : 1 / 2;
    return gapStart + (gapEnd - gapStart) * fraction;
  };
  const routes = new Map(
    forward.map((item) => {
      const lane = lanes.get(item.edge.id);
      return [
        item.edge.id,
        {
          turnAlong: turnIn(item.targetRow, item.edge.id),
          lane:
            lane === undefined
              ? undefined
              : {
                  across: lane,
                  turnAlong: turnIn(
                    item.sourceRow + 1,
                    laneRunId(item.edge.id)
                  ),
                },
        },
      ];
    })
  );
  return { shift, routeOf: (edgeId) => routes.get(edgeId) };
}
