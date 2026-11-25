import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { moveStepInSequence } from "#src/lib/move-step";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

function lifecycle(): WorkflowNode {
  return {
    id: "start",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Start", type: "lifecycle" },
  };
}

function step(
  id: string,
  y: number,
  options: { parentId?: string; actionType?: string } = {}
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y },
    ...omitUndefined({ parentId: options.parentId }),
    data: {
      label: id,
      type: "action",
      config: { actionType: options.actionType ?? "host/send" },
    },
  };
}

function edge(
  source: string,
  target: string,
  sourceHandle: string | null = null
): WorkflowEdge {
  return { id: `${source}-${target}`, source, target, sourceHandle };
}

/** Each edge as "source→target", in a stable order. */
function wiring(edges: readonly WorkflowEdge[]): string[] {
  return edges.map((item) => `${item.source}→${item.target}`).toSorted();
}

const SEQUENCE = {
  nodes: [lifecycle(), step("a", 100), step("b", 200), step("c", 300)],
  edges: [edge("start", "a", "started"), edge("a", "b"), edge("b", "c")],
};

describe("moveStepInSequence", () => {
  it("swaps a step with the one before it, connections and positions both", () => {
    const outcome = moveStepInSequence({
      ...SEQUENCE,
      nodeId: "b",
      direction: "up",
    });
    if ("refusal" in outcome) throw new Error(outcome.refusal);

    expect(wiring(outcome.edges)).toEqual(["a→c", "b→a", "start→b"]);
    // The Lifecycle Node's outlet stays the outlet the edge leaves by.
    expect(
      outcome.edges.find((item) => item.source === "start")?.sourceHandle
    ).toBe("started");
    const y = (id: string) =>
      outcome.nodes.find((node) => node.id === id)?.position.y;
    expect([y("b"), y("a")]).toEqual([100, 200]);
  });

  it("swaps a step with the one after it", () => {
    const outcome = moveStepInSequence({
      ...SEQUENCE,
      nodeId: "b",
      direction: "down",
    });
    if ("refusal" in outcome) throw new Error(outcome.refusal);

    expect(wiring(outcome.edges)).toEqual(["a→c", "c→b", "start→a"]);
  });

  it("refuses to move the first step above the Lifecycle Node or the last step past its end", () => {
    expect(
      moveStepInSequence({ ...SEQUENCE, nodeId: "a", direction: "up" })
    ).toEqual({ refusal: "This step is first in its path." });
    expect(
      moveStepInSequence({ ...SEQUENCE, nodeId: "c", direction: "down" })
    ).toEqual({ refusal: "This step is last in its path." });
  });

  it("refuses a step where paths meet or split", () => {
    const join = {
      nodes: [lifecycle(), step("a", 100), step("x", 100), step("j", 200)],
      edges: [
        edge("start", "a", "started"),
        edge("start", "x", "started"),
        edge("a", "j"),
        edge("x", "j"),
      ],
    };
    expect(
      moveStepInSequence({ ...join, nodeId: "j", direction: "up" })
    ).toEqual({
      refusal:
        "Several paths meet at this step, so it has no one step before it.",
    });

    const fanOut = {
      nodes: [lifecycle(), step("a", 100), step("b", 200), step("c", 200)],
      edges: [edge("start", "a", "started"), edge("a", "b"), edge("a", "c")],
    };
    expect(
      moveStepInSequence({ ...fanOut, nodeId: "b", direction: "up" })
    ).toEqual({
      refusal:
        "These steps sit where paths split or meet, so they cannot trade places.",
    });
  });

  it("keeps a Condition in place, since its branches would have to move with it", () => {
    const graph = {
      nodes: [
        lifecycle(),
        step("a", 100),
        step("check", 200, { actionType: BUILT_IN_ACTION_IDS.condition }),
        step("yes", 300),
      ],
      edges: [
        edge("start", "a", "started"),
        edge("a", "check"),
        edge("check", "yes", "true"),
      ],
    };
    const refusal = {
      refusal:
        "A Condition or an Event Split keeps its place, because its branches move with it.",
    };
    expect(
      moveStepInSequence({ ...graph, nodeId: "check", direction: "up" })
    ).toEqual(refusal);
    expect(
      moveStepInSequence({ ...graph, nodeId: "a", direction: "down" })
    ).toEqual(refusal);
  });

  it("moves a step within its Group and not across the Group's edge", () => {
    const group: WorkflowNode = {
      id: "grp",
      type: "group",
      position: { x: 0, y: 200 },
      data: { label: "Reminders", type: "group" },
    };
    const graph = {
      nodes: [
        lifecycle(),
        step("a", 100),
        group,
        step("m1", 20, { parentId: "grp" }),
        step("m2", 120, { parentId: "grp" }),
      ],
      edges: [edge("start", "a", "started"), edge("a", "m1"), edge("m1", "m2")],
    };
    expect(
      moveStepInSequence({ ...graph, nodeId: "m1", direction: "up" })
    ).toEqual({ refusal: "Move a step within its Group." });

    const inside = moveStepInSequence({
      ...graph,
      nodeId: "m2",
      direction: "up",
    });
    if ("refusal" in inside) throw new Error(inside.refusal);
    expect(wiring(inside.edges)).toEqual(["a→m2", "m2→m1", "start→a"]);
  });
});
