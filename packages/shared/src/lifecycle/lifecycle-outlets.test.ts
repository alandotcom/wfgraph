import { describe, expect, it } from "vitest";
import {
  entryOutletsReaching,
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
  type LifecycleOutlet,
  nodesBehindOutlet,
} from "#src/lifecycle/lifecycle-outlets";
import type { WorkflowEdge } from "#src/graph/types";

function edge(input: {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}): WorkflowEdge {
  return input;
}

/**
 * A diamond: the entry node opens both outlets, each branch runs a node of its
 * own, and both rejoin at "join".
 *
 * No editor draws this yet. The Canceled outlet is a handle stage 7 adds, so
 * every graph today leaves one outlet, and the cases below are the walk's answer
 * waiting for the canvas that can pose the question.
 */
const diamond: WorkflowEdge[] = [
  edge({
    id: "e1",
    source: "entry",
    target: "on_start",
    sourceHandle: LIFECYCLE_STARTED_HANDLE,
  }),
  edge({
    id: "e2",
    source: "entry",
    target: "on_cancel",
    sourceHandle: LIFECYCLE_CANCELED_HANDLE,
  }),
  edge({ id: "e3", source: "on_start", target: "join" }),
  edge({ id: "e4", source: "on_cancel", target: "join" }),
];

function outletsFor(targetNodeId: string, edges = diamond): string[] {
  return [
    ...entryOutletsReaching({ entryNodeId: "entry", targetNodeId, edges }),
  ].toSorted();
}

describe("entryOutletsReaching", () => {
  it("names the one outlet a branch hangs off", () => {
    expect(outletsFor("on_start")).toEqual([LIFECYCLE_STARTED_HANDLE]);
    expect(outletsFor("on_cancel")).toEqual([LIFECYCLE_CANCELED_HANDLE]);
  });

  it("names both where the branches rejoin", () => {
    expect(outletsFor("join")).toEqual([
      LIFECYCLE_CANCELED_HANDLE,
      LIFECYCLE_STARTED_HANDLE,
    ]);
  });

  it("follows a chain of any length", () => {
    expect(
      outletsFor("last", [
        ...diamond,
        edge({ id: "e5", source: "join", target: "next" }),
        edge({ id: "e6", source: "next", target: "last" }),
      ])
    ).toEqual([LIFECYCLE_CANCELED_HANDLE, LIFECYCLE_STARTED_HANDLE]);
  });

  it("names none for a node the entry node does not reach", () => {
    expect(outletsFor("stranded")).toEqual([]);
  });

  it("names none for an edge that leaves the entry node unlabelled", () => {
    // The save refuses such an edge, because with two handles drawn an unnamed
    // edge would bind by whichever order React Flow rendered them in.
    expect(
      outletsFor("orphan", [
        edge({ id: "e1", source: "entry", target: "orphan" }),
      ])
    ).toEqual([]);
  });

  it("terminates on a cycle in the edges it is handed", () => {
    // Saving refuses a cyclic graph, and the walk is called during render on
    // whatever the canvas currently holds.
    expect(
      outletsFor("b", [
        edge({
          id: "e1",
          source: "entry",
          target: "a",
          sourceHandle: LIFECYCLE_STARTED_HANDLE,
        }),
        edge({ id: "e2", source: "a", target: "b" }),
        edge({ id: "e3", source: "b", target: "a" }),
      ])
    ).toEqual([LIFECYCLE_STARTED_HANDLE]);
  });
});

describe("nodesBehindOutlet", () => {
  function behind(outlet: LifecycleOutlet, edges = diamond): string[] {
    return [
      ...nodesBehindOutlet({
        entryNodeIds: new Set(["entry"]),
        outlet,
        edges,
      }),
    ].toSorted();
  }

  it("collects the branch's own node and everything downstream of it", () => {
    expect(behind(LIFECYCLE_CANCELED_HANDLE)).toEqual(["join", "on_cancel"]);
    expect(behind(LIFECYCLE_STARTED_HANDLE)).toEqual(["join", "on_start"]);
  });

  it("collects nothing for an outlet no edge leaves", () => {
    expect(
      behind(LIFECYCLE_CANCELED_HANDLE, [
        edge({
          id: "e1",
          source: "entry",
          target: "on_start",
          sourceHandle: LIFECYCLE_STARTED_HANDLE,
        }),
      ])
    ).toEqual([]);
  });

  it("terminates on a cycle in the edges it is handed", () => {
    expect(
      behind(LIFECYCLE_STARTED_HANDLE, [
        edge({
          id: "e1",
          source: "entry",
          target: "a",
          sourceHandle: LIFECYCLE_STARTED_HANDLE,
        }),
        edge({ id: "e2", source: "a", target: "b" }),
        edge({ id: "e3", source: "b", target: "a" }),
      ])
    ).toEqual(["a", "b"]);
  });
});
