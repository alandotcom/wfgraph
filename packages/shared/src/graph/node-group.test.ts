import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import {
  analyzeGroupableSelection,
  displayEdgesForGroups,
  edgesForGroupLayout,
  expandGroupCopyIds,
  isGroupNode,
  resolveStoredEndpoint,
  undersizedGroupIds,
  type GroupGraphNode,
} from "#src/graph/node-group";
import type { WorkflowEdge } from "#src/graph/types";

function action(
  id: string,
  actionType: string,
  extra?: Partial<GroupGraphNode>
): GroupGraphNode {
  return {
    id,
    ...extra,
    data: {
      type: "action",
      label: id,
      config: { actionType },
      ...extra?.data,
    },
  };
}

function group(
  id: string,
  entryNodeId: string,
  exitNodeId: string
): GroupGraphNode {
  return {
    id,
    data: {
      type: "group",
      label: "Group",
      config: { entryNodeId, exitNodeId },
    },
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return { id, source, target, sourceHandle };
}

const lookupA = action("a", "fountain/get-user");
const lookupB = action("b", "fountain/get-appointment");
const condition = action("c", BUILT_IN_ACTION_IDS.condition);
const wait = action("w", BUILT_IN_ACTION_IDS.wait);
const split = action("s", BUILT_IN_ACTION_IDS.eventSplit);

describe("analyzeGroupableSelection", () => {
  it("accepts a lookup chain that ends on an unwired Condition", () => {
    const result = analyzeGroupableSelection(
      [lookupA, lookupB, condition],
      [
        edge("e1", "a", "b"),
        edge("e2", "b", "c"),
        edge("e-out", "c", "sms", "true"),
      ],
      new Set(["a", "b", "c"])
    );

    expect(result).toEqual({
      ok: true,
      entryId: "a",
      exitId: "c",
      memberIds: ["a", "b", "c"],
    });
  });

  it("refuses Wait and Event Split", () => {
    expect(
      analyzeGroupableSelection(
        [lookupA, wait],
        [edge("e1", "a", "w")],
        new Set(["a", "w"])
      )
    ).toMatchObject({ ok: false, error: "Wait cannot be grouped" });

    expect(
      analyzeGroupableSelection(
        [lookupA, split],
        [edge("e1", "a", "s")],
        new Set(["a", "s"])
      )
    ).toMatchObject({ ok: false, error: "Event Split cannot be grouped" });
  });

  it("refuses a Condition False that leaves the selection", () => {
    expect(
      analyzeGroupableSelection(
        [lookupA, condition],
        [
          edge("e1", "a", "c"),
          edge("e-true", "c", "sms", "true"),
          edge("e-false", "c", "cancel", "false"),
        ],
        new Set(["a", "c"])
      )
    ).toMatchObject({
      ok: false,
      error: "Condition False cannot leave the group",
    });
  });

  it("refuses two entries or one step", () => {
    expect(
      analyzeGroupableSelection([lookupA, lookupB], [], new Set(["a", "b"]))
    ).toMatchObject({ ok: false, error: "Needs exactly one entry step" });

    expect(
      analyzeGroupableSelection([lookupA], [], new Set(["a"]))
    ).toMatchObject({ ok: false, error: "Select at least two steps" });
  });

  it("refuses nodes already inside a group", () => {
    expect(
      analyzeGroupableSelection(
        [
          { ...lookupA, parentId: "g" },
          { ...lookupB, parentId: "g" },
        ],
        [edge("e1", "a", "b")],
        new Set(["a", "b"])
      )
    ).toMatchObject({ ok: false, error: "Already in a group" });
  });
});

describe("display and store endpoints", () => {
  it("paints boundary edges on the group frame", () => {
    const nodes: GroupGraphNode[] = [
      action("life", "ignored", {
        data: { type: "lifecycle", label: "Start" },
      }),
      group("g", "a", "c"),
      { ...lookupA, parentId: "g" },
      { ...lookupB, parentId: "g" },
      { ...condition, parentId: "g" },
      action("sms", "resend/send-email"),
    ];
    const edges = [
      edge("in", "life", "a", "started"),
      edge("ab", "a", "b"),
      edge("bc", "b", "c"),
      edge("out", "c", "sms", "true"),
    ];

    expect(displayEdgesForGroups(nodes, edges)).toEqual([
      { ...edges[0], target: "g" },
      edges[1],
      edges[2],
      { ...edges[3], source: "g" },
    ]);

    expect(edgesForGroupLayout(nodes, edges).map((item) => item.id)).toEqual([
      "in",
      "out",
    ]);

    expect(resolveStoredEndpoint(nodes, "g", "target")).toBe("a");
    expect(resolveStoredEndpoint(nodes, "g", "source")).toBe("c");
  });
});

describe("expandGroupCopyIds", () => {
  it("takes the frame and every child when either is selected", () => {
    const nodes = [
      group("g", "a", "c"),
      { ...lookupA, parentId: "g" },
      { ...condition, parentId: "g" },
      action("sms", "resend/send-email"),
    ];

    expect([...expandGroupCopyIds(nodes, new Set(["g"]))].sort()).toEqual([
      "a",
      "c",
      "g",
    ]);
    expect([...expandGroupCopyIds(nodes, new Set(["a"]))].sort()).toEqual([
      "a",
      "c",
      "g",
    ]);
  });
});

describe("isGroupNode", () => {
  it("reads data.type, not the React Flow type field", () => {
    expect(isGroupNode(group("g", "a", "c"))).toBe(true);
    expect(isGroupNode(lookupA)).toBe(false);
  });
});

describe("undersizedGroupIds", () => {
  it("names a group that no longer holds two children", () => {
    const nodes = [group("g", "a", "c"), { ...lookupA, parentId: "g" }];
    expect(undersizedGroupIds(nodes)).toEqual(["g"]);
  });
});
