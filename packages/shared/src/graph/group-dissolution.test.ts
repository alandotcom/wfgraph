import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import { groupContractViolations } from "#src/graph/group-contract";
import {
  dissolveGroups,
  releaseAtGroupCanvasPosition,
  repairGroups,
} from "#src/graph/group-dissolution";
import { groupStructureRefusalReason } from "#src/graph/group-structure";
import { overlappingCardIds } from "#src/graph/node-placement-test-support";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import {
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
} from "#src/graph/workflow-layout-geometry";
import { omitUndefined } from "#src/utils/omit-undefined";

function frame(id: string, position = { x: 100, y: 200 }): WorkflowNode {
  return {
    id,
    type: "group",
    position,
    width: 400,
    height: 300,
    data: { label: `Frame ${id}`, type: "group" },
  };
}

function lookup(
  id: string,
  parentId?: string,
  position = { x: 10, y: 20 }
): WorkflowNode {
  return omitUndefined({
    id,
    position,
    data: {
      label: `Lookup ${id}`,
      type: "action" as const,
      config: { actionType: "fountain/get-user" },
      enabled: false,
    },
    parentId,
  });
}

const edges: WorkflowEdge[] = [
  { id: "ab", source: "a", target: "b" },
  { id: "b-out", source: "b", target: "after" },
];

function dissolve(nodes: readonly WorkflowNode[], ...groupIds: string[]) {
  return dissolveGroups({
    nodes,
    groupIds: new Set(groupIds),
    releaseMember: releaseAtGroupCanvasPosition({ nodes }),
  });
}

describe("dissolveGroups", () => {
  it("removes the frame and releases its members where the focused Group canvas draws them", () => {
    const nodes = [
      frame("g"),
      lookup("a", "g", { x: 10, y: 20 }),
      lookup("b", "g", { x: 30, y: 40 }),
      lookup("after", undefined, { x: 0, y: 900 }),
    ];

    const dissolved = dissolve(nodes, "g");

    expect(dissolved.map((node) => node.id)).toEqual(["a", "b", "after"]);
    expect(dissolved[0]).not.toHaveProperty("parentId");
    // Ungroup translates stored positions, including an intentional overlap.
    expect(dissolved[0]?.position).toEqual({ x: 110, y: 220 });
    expect(dissolved[1]?.position).toEqual({ x: 130, y: 240 });
    expect(dissolved[2]).toBe(nodes[3]);
    expect(groupStructureRefusalReason({ nodes: dissolved, edges })).toBeNull();
  });

  it("keeps each member's data, including its enabled state", () => {
    const nodes = [frame("g"), lookup("a", "g"), lookup("b", "g")];

    const dissolved = dissolve(nodes, "g");

    expect(dissolved.map((node) => node.data)).toEqual([
      nodes[1]?.data,
      nodes[2]?.data,
    ]);
  });

  it("answers the node the caller's releaseMember builds", () => {
    const nodes = [frame("g"), lookup("a", "g"), lookup("b", "g")];

    const dissolved = dissolveGroups({
      nodes,
      groupIds: new Set(["g"]),
      releaseMember: ({ frame: parent, member }) => ({
        id: member.id,
        data: member.data,
        position: { x: parent.position.x * 2 + member.position.x, y: 0 },
      }),
    });

    expect(dissolved).toEqual([
      { id: "a", data: nodes[1]?.data, position: { x: 210, y: 0 } },
      { id: "b", data: nodes[2]?.data, position: { x: 210, y: 0 } },
    ]);
  });

  it("dissolves several frames in one pass and leaves another Group whole", () => {
    const nodes = [
      frame("g"),
      frame("h"),
      frame("k"),
      lookup("a", "g"),
      lookup("b", "g"),
      lookup("c", "h"),
      lookup("d", "h"),
      lookup("e", "k"),
      lookup("f", "k"),
    ];

    const dissolved = dissolve(nodes, "g", "k");

    expect(dissolved.map((node) => [node.id, node.parentId])).toEqual([
      ["h", undefined],
      ["a", undefined],
      ["b", undefined],
      ["c", "h"],
      ["d", "h"],
      ["e", undefined],
      ["f", undefined],
    ]);
    expect(dissolved[3]).toBe(nodes[5]);
  });

  /**
   * A pasted Group sits 48px down and right of the Group it was copied from,
   * above a step. Released where the focused Group canvas draws them, its
   * first member lands on the original Group card and its second on the step.
   */
  it("moves the released members of one frame together clear of every overview card", () => {
    const nodes = [
      frame("original", { x: 624, y: 265 }),
      frame("pasted", { x: 672, y: 313 }),
      lookup("a", "original"),
      lookup("b", "original"),
      lookup("p1", "pasted"),
      lookup("p2", "pasted", {
        x: 10,
        y: 20 + WORKFLOW_NODE_HEIGHT + RANK_SPACING,
      }),
      lookup("three", undefined, { x: 624, y: 585 }),
    ];
    const dissolved = dissolveGroups({
      nodes,
      groupIds: new Set(["pasted"]),
      releaseMember: releaseAtGroupCanvasPosition({ nodes }),
    });

    const byId = new Map(dissolved.map((node) => [node.id, node]));
    const p1 = byId.get("p1")?.position;
    const p2 = byId.get("p2")?.position;
    // The two members keep their rows, one card and one rank gap apart.
    expect(p1 && p2 && p2.y - p1.y).toBe(WORKFLOW_NODE_HEIGHT + RANK_SPACING);
    expect(p1 && p2 && p2.x - p1.x).toBe(0);
    // Existing nodes stay where they were.
    expect(byId.get("original")).toBe(nodes[0]);
    expect(byId.get("three")).toBe(nodes[6]);
    expect(overlappingCardIds(dissolved)).toEqual([]);
  });

  it("keeps the members of frames dissolved in one pass clear of each other", () => {
    const nodes = [
      frame("g", { x: 0, y: 0 }),
      frame("h", { x: 0, y: 0 }),
      lookup("a", "g"),
      lookup("b", "g", { x: 10, y: 220 }),
      lookup("c", "h"),
      lookup("d", "h", { x: 10, y: 220 }),
    ];

    const dissolved = dissolveGroups({
      nodes,
      groupIds: new Set(["g", "h"]),
      releaseMember: releaseAtGroupCanvasPosition({ nodes }),
    });

    expect(dissolved.map((node) => node.id)).toEqual(["a", "b", "c", "d"]);
    expect(overlappingCardIds(dissolved)).toEqual([]);
  });

  it("answers the same array for ids that name no Group frame", () => {
    const nodes: readonly WorkflowNode[] = [
      frame("g"),
      lookup("a", "g"),
      lookup("b", "g"),
    ];

    expect(dissolve(nodes, "a")).toBe(nodes);
    expect(dissolve(nodes, "missing")).toBe(nodes);
    expect(dissolve(nodes)).toBe(nodes);
  });
});

describe("repairGroups", () => {
  function eventSplit(id: string, parentId: string): WorkflowNode {
    return {
      id,
      position: { x: 0, y: 0 },
      parentId,
      data: {
        label: id,
        type: "action",
        config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
      },
    };
  }

  it("dissolves a Group left with one member and keeps a Group with two", () => {
    const nodes = [
      frame("g"),
      frame("h", { x: 700, y: 200 }),
      lookup("a", "g"),
      lookup("c", "h"),
      lookup("d", "h"),
    ];

    const repair = repairGroups({
      nodes,
      edges: [],
      releaseMember: releaseAtGroupCanvasPosition({ nodes }),
    });

    expect(repair.ok).toBe(true);
    if (!repair.ok) {
      return;
    }
    expect(repair.dissolvedGroupIds).toEqual(["g"]);
    expect(repair.nodes.map((node) => node.id)).toEqual(["h", "a", "c", "d"]);
    expect(repair.nodes[1]).not.toHaveProperty("parentId");
    expect(repair.nodes[1]?.position).toEqual({ x: 110, y: 220 });
  });

  it("removes a frame with no members", () => {
    const nodes = [frame("g"), lookup("a")];

    const repair = repairGroups({
      nodes,
      edges: [],
      releaseMember: releaseAtGroupCanvasPosition({ nodes }),
    });

    expect(repair).toEqual({
      ok: true,
      nodes: [nodes[1]],
      dissolvedGroupIds: ["g"],
    });
  });

  it("dissolves a Group whose id names a prototype member", () => {
    const nodes = [frame("constructor"), lookup("a", "constructor")];

    const repair = repairGroups({
      nodes,
      edges: [],
      releaseMember: releaseAtGroupCanvasPosition({ nodes }),
    });

    expect(repair.ok && repair.nodes.map((node) => node.id)).toEqual(["a"]);
  });

  it("counts steps the way Publish's too_few_members rule does", () => {
    // An Event Split is no step a Group may hold, so a Group of one lookup and
    // one Event Split is too small for Publish and for dissolution alike.
    const nodes = [frame("g"), lookup("a", "g"), eventSplit("s", "g")];

    const repair = repairGroups({
      nodes,
      edges: [],
      releaseMember: releaseAtGroupCanvasPosition({ nodes }),
    });

    expect(
      groupContractViolations({ nodes, edges: [] }).map((item) => item.rule)
    ).toContain("too_few_members");
    expect(repair.ok && repair.dissolvedGroupIds).toEqual(["g"]);
  });

  it("answers the same array when every Group holds two steps", () => {
    const nodes = [frame("g"), lookup("a", "g"), lookup("b", "g")];

    expect(
      repairGroups({
        nodes,
        edges,
        releaseMember: releaseAtGroupCanvasPosition({ nodes }),
      })
    ).toEqual({ ok: true, nodes, dissolvedGroupIds: [] });
    const repair = repairGroups({
      nodes,
      edges,
      releaseMember: releaseAtGroupCanvasPosition({ nodes }),
    });
    expect(repair.ok && repair.nodes).toBe(nodes);
  });

  it("refuses a graph whose Group structure dissolution cannot repair", () => {
    const nodes = [lookup("a", "gone"), lookup("b", "gone")];

    const repair = repairGroups({
      nodes,
      edges: [],
      releaseMember: releaseAtGroupCanvasPosition({ nodes }),
    });

    expect(repair.ok).toBe(false);
    expect(!repair.ok && repair.reason).toBe(
      groupStructureRefusalReason({ nodes, edges: [] })
    );
  });
});
