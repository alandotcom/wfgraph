import { describe, expect, it } from "vitest";
import { cornerRadii } from "#src/components/flow-elements/edge-path";
import {
  assignGapTracks,
  drawnStretches,
  type GapEdge,
} from "#src/lib/group-edge-tracks";

const gapEdge = (
  id: string,
  from: number,
  to: number,
  ports: { source?: string; target?: string } = {}
): GapEdge => ({
  id,
  sourcePort: ports.source ?? `${id}-out`,
  targetPort: ports.target ?? `${id}-in`,
  from,
  to,
});

describe("assignGapTracks", () => {
  it("gives a straight edge no track and one bent edge the only track", () => {
    const { trackOf, trackCount } = assignGapTracks([
      gapEdge("straight", 0, 0),
      gapEdge("bent", -150, -300),
    ]);
    expect([...trackOf]).toEqual([["bent", 0]]);
    expect(trackCount).toBe(1);
  });

  it("puts edges whose runs touch on separate tracks unless they share a port", () => {
    const { trackOf, trackCount } = assignGapTracks([
      gapEdge("a", 0, 300),
      gapEdge("b", 150, 600),
      gapEdge("c", 0, -300, { source: "a-out" }),
      gapEdge("d", 450, 600, { target: "b-in" }),
    ]);
    expect(trackOf.get("a")).not.toBe(trackOf.get("b"));
    expect(trackOf.get("c")).toBe(trackOf.get("a"));
    expect(trackCount).toBe(2);
  });

  it("joins edges into one target on one track though a lower track is free for one of them", () => {
    const { trackOf } = assignGapTracks([
      gapEdge("crossing", -100, 100),
      gapEdge("left", 0, 300, { target: "join-in" }),
      gapEdge("right", 600, 300, { target: "join-in" }),
    ]);
    expect(trackOf.get("left")).toBe(1);
    expect(trackOf.get("right")).toBe(trackOf.get("left"));
  });

  it("turns an edge leaving a column before an edge entering that column", () => {
    // `into` enters the column `outOf` leaves; were `outOf` to turn later, its
    // run down to its turn would draw over `into`'s run down to its target.
    const { trackOf } = assignGapTracks([
      gapEdge("into", 600, 0),
      gapEdge("outOf", 0, -300),
    ]);
    expect(trackOf.get("outOf")).toBeLessThan(trackOf.get("into") ?? 0);
  });

  it("answers the same tracks whatever order the edges are listed in", () => {
    const edges = [
      gapEdge("a", 0, 300),
      gapEdge("b", 300, 600),
      gapEdge("c", 600, 0),
      gapEdge("d", -300, 450),
    ];
    const forward = assignGapTracks(edges);
    const reversed = assignGapTracks(edges.toReversed());
    expect(Object.fromEntries(reversed.trackOf)).toEqual(
      Object.fromEntries(forward.trackOf)
    );
  });
});

describe("drawnStretches", () => {
  // Three edges forking from one outlet at (0, 0), turning at y 40 toward
  // columns 0, 300 and 600, and a fourth edge from elsewhere joining the
  // edge into column 300.
  const fork = (id: string, column: number) => ({
    id,
    sourcePort: "out",
    targetPort: `${id}-in`,
    corners:
      column === 0
        ? [
            { x: 0, y: 0 },
            { x: 0, y: 100 },
          ]
        : [
            { x: 0, y: 0 },
            { x: 0, y: 40 },
            { x: column, y: 40 },
            { x: column, y: 100 },
          ],
    turnOffset: 40,
  });

  it("leaves each shared run of a fork and a join to the shorter edge", () => {
    const stretches = drawnStretches(
      [
        fork("far", 600),
        fork("straight", 0),
        fork("near", 300),
        {
          id: "joining",
          sourcePort: "other-out",
          targetPort: "near-in",
          corners: [
            { x: 900, y: 0 },
            { x: 900, y: 40 },
            { x: 300, y: 40 },
            { x: 300, y: 100 },
          ],
          turnOffset: 40,
        },
      ],
      cornerRadii
    );
    expect(Object.fromEntries(stretches)).toEqual({
      // The straight edge draws the outlet's run down to where `near` turns.
      near: { from: -16 },
      // `near` draws the run across to its own turn into column 300.
      far: { from: 284 },
      // `near` draws the run into column 300 from where `joining` turns in.
      joining: { to: 616 },
    });
  });
});
