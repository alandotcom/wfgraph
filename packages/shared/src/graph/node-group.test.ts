import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import {
  analyzeGroupableSelection,
  displayEdgesForGroups,
  edgesForGroupLayout,
  expandGroupCopyIds,
  fanOutStoreEdgeIds,
  fanOutStoreEdges,
  groupMemberSlots,
  groupOutletHandle,
  isGroupNode,
  orderGroupParentsFirst,
  resolveStoredSource,
  storedTargetsFor,
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
  entryNodeIds: string[],
  exitNodeId: string,
  outletHandle?: "true"
): GroupGraphNode {
  return {
    id,
    data: {
      type: "group",
      label: "Group",
      config: {
        entryNodeIds,
        exitNodeId,
        ...(outletHandle ? { outletHandle } : {}),
      },
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
      entryIds: ["a"],
      exitId: "c",
      memberIds: ["a", "b", "c"],
    });
  });

  it("accepts parallel lookups that AND-join at a Condition", () => {
    const result = analyzeGroupableSelection(
      [lookupA, lookupB, condition],
      [
        edge("e-a", "a", "c"),
        edge("e-b", "b", "c"),
        edge("e-out", "c", "sms", "true"),
      ],
      new Set(["a", "b", "c"])
    );

    expect(result).toEqual({
      ok: true,
      entryIds: ["a", "b"],
      exitId: "c",
      memberIds: ["a", "b", "c"],
    });
  });

  it("accepts parallel lookups that already share a Started inlet", () => {
    const result = analyzeGroupableSelection(
      [lookupA, lookupB, condition],
      [
        edge("e-start-a", "life", "a", "started"),
        edge("e-start-b", "life", "b", "started"),
        edge("e-a", "a", "c"),
        edge("e-b", "b", "c"),
      ],
      new Set(["a", "b", "c"])
    );

    expect(result).toMatchObject({
      ok: true,
      entryIds: ["a", "b"],
      exitId: "c",
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

  it("refuses two exits or one step", () => {
    expect(
      analyzeGroupableSelection([lookupA, lookupB], [], new Set(["a", "b"]))
    ).toMatchObject({ ok: false, error: "Needs exactly one exit step" });

    expect(
      analyzeGroupableSelection([lookupA], [], new Set(["a"]))
    ).toMatchObject({ ok: false, error: "Select at least two steps" });
  });

  it("refuses parallel lookups wired from different steps", () => {
    expect(
      analyzeGroupableSelection(
        [lookupA, lookupB, condition],
        [
          edge("e-start-a", "life", "a", "started"),
          edge("e-wait-b", "w", "b"),
          edge("e-a", "a", "c"),
          edge("e-b", "b", "c"),
        ],
        new Set(["a", "b", "c"])
      )
    ).toMatchObject({
      ok: false,
      error: "Parallel lookups must share the same incoming step",
    });
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
      group("g", ["a"], "c"),
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

    expect(resolveStoredSource(nodes, "g")).toBe("c");
    expect(storedTargetsFor(nodes, "g")).toEqual(["a"]);
  });

  it("collapses a parallel fan-out onto one painted inlet", () => {
    const nodes: GroupGraphNode[] = [
      action("life", "ignored", {
        data: { type: "lifecycle", label: "Start" },
      }),
      group("g", ["a", "b"], "c"),
      { ...lookupA, parentId: "g" },
      { ...lookupB, parentId: "g" },
      { ...condition, parentId: "g" },
    ];
    const edges = [
      edge("in-a", "life", "a", "started"),
      edge("in-b", "life", "b", "started"),
      edge("a-c", "a", "c"),
      edge("b-c", "b", "c"),
    ];

    expect(displayEdgesForGroups(nodes, edges)).toEqual([
      { ...edges[0], target: "g" },
      edges[2],
      edges[3],
    ]);
    expect(storedTargetsFor(nodes, "g")).toEqual(["a", "b"]);
    expect(fanOutStoreEdgeIds(nodes, edges, "in-a")).toEqual(["in-a", "in-b"]);
    expect(
      fanOutStoreEdges({
        nodes,
        edges,
        sourceId: "life",
        targetId: "g",
        sourceHandle: "started",
      })
    ).toEqual([]);
    expect(
      fanOutStoreEdges({
        nodes,
        edges: [],
        sourceId: "life",
        targetId: "g",
        sourceHandle: "started",
      })
    ).toEqual([
      { source: "life", target: "a", sourceHandle: "started" },
      { source: "life", target: "b", sourceHandle: "started" },
    ]);
  });
});

describe("groupMemberSlots", () => {
  it("places parallel lookups on one row and the join below", () => {
    expect(
      groupMemberSlots(
        ["a", "b", "c"],
        [edge("e-a", "a", "c"), edge("e-b", "b", "c")],
        ["a", "b"]
      )
    ).toEqual([
      { id: "a", row: 0, column: 0 },
      { id: "b", row: 0, column: 1 },
      { id: "c", row: 1, column: 0 },
    ]);
  });
});

describe("expandGroupCopyIds", () => {
  it("takes the frame and every child when either is selected", () => {
    const nodes = [
      group("g", ["a"], "c"),
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
    expect(isGroupNode(group("g", ["a"], "c"))).toBe(true);
    expect(isGroupNode(lookupA)).toBe(false);
  });
});

describe("undersizedGroupIds", () => {
  it("names a group that no longer holds two children", () => {
    const nodes = [group("g", ["a"], "c"), { ...lookupA, parentId: "g" }];
    expect(undersizedGroupIds(nodes)).toEqual(["g"]);
  });
});

describe("groupOutletHandle", () => {
  it("reads the baked Condition outlet and ignores an absent one", () => {
    expect(groupOutletHandle(group("g", ["a"], "c", "true"))).toBe("true");
    expect(groupOutletHandle(group("g", ["a"], "c"))).toBeUndefined();
  });
});

describe("orderGroupParentsFirst", () => {
  it("returns the same array when rest, groups, and children are already ordered", () => {
    const nodes = [
      action("life", "ignored", {
        data: { type: "lifecycle", label: "Start" },
      }),
      group("g", ["a"], "c"),
      { ...lookupA, parentId: "g" },
    ];
    expect(orderGroupParentsFirst(nodes)).toBe(nodes);
  });

  it("reorders when a child sits before its group", () => {
    const child = { ...lookupA, parentId: "g" };
    const frame = group("g", ["a"], "c");
    const rest = action("sms", "resend/send-email");
    expect(orderGroupParentsFirst([child, rest, frame])).toEqual([
      rest,
      frame,
      child,
    ]);
  });
});
