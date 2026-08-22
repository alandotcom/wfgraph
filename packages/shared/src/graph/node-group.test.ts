import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import type { ExtensionCatalog } from "#src/extensions/catalog";
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
  resolveStoredSources,
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
  exitNodeIds: string[],
  outletHandle?: "true"
): GroupGraphNode {
  return {
    id,
    data: {
      type: "group",
      label: "Group",
      config: {
        entryNodeIds,
        exitNodeIds,
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
const sendEmail = action("sms", "resend/send-email");

/**
 * The two lookups the fixtures group, and the one send they may not. Only
 * `sideEffect` matters to these cases; the rest is what the type asks for.
 */
const catalog: ExtensionCatalog = {
  events: [],
  actions: [
    {
      id: "fountain/get-user",
      label: "Get User",
      description: "Reads a user",
      category: "Fountain",
      configFields: [],
      outputFields: [],
    },
    {
      id: "fountain/get-appointment",
      label: "Get Appointment",
      description: "Reads an appointment",
      category: "Fountain",
      configFields: [],
      outputFields: [],
    },
    {
      id: "resend/send-email",
      label: "Send Email",
      description: "Sends an email",
      category: "Resend",
      sideEffect: true,
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [],
};

describe("analyzeGroupableSelection", () => {
  it("accepts a lookup chain that ends on an unwired Condition", () => {
    const result = analyzeGroupableSelection(
      [lookupA, lookupB, condition],
      [
        edge("e1", "a", "b"),
        edge("e2", "b", "c"),
        edge("e-out", "c", "sms", "true"),
      ],
      new Set(["a", "b", "c"]),
      catalog
    );

    expect(result).toEqual({
      ok: true,
      entryIds: ["a"],
      exitIds: ["c"],
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
      new Set(["a", "b", "c"]),
      catalog
    );

    expect(result).toEqual({
      ok: true,
      entryIds: ["a", "b"],
      exitIds: ["c"],
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
      new Set(["a", "b", "c"]),
      catalog
    );

    expect(result).toMatchObject({
      ok: true,
      entryIds: ["a", "b"],
      exitIds: ["c"],
    });
  });

  it("accepts disconnected lookups with a shared predecessor and outgoing target", () => {
    const result = analyzeGroupableSelection(
      [lookupA, lookupB],
      [
        edge("e-start-a", "life", "a", "started"),
        edge("e-start-b", "life", "b", "started"),
        { ...edge("e-a-out", "a", "sms"), targetHandle: "input" },
        { ...edge("e-b-out", "b", "sms"), targetHandle: "input" },
      ],
      new Set(["a", "b"]),
      catalog
    );

    expect(result).toEqual({
      ok: true,
      entryIds: ["a", "b"],
      exitIds: ["a", "b"],
      memberIds: ["a", "b"],
    });
  });

  it("refuses parallel lookup exits with different target handles", () => {
    expect(
      analyzeGroupableSelection(
        [lookupA, lookupB],
        [
          edge("e-start-a", "life", "a", "started"),
          edge("e-start-b", "life", "b", "started"),
          { ...edge("e-a-out", "a", "sms"), targetHandle: "one" },
          { ...edge("e-b-out", "b", "sms"), targetHandle: "two" },
        ],
        new Set(["a", "b"]),
        catalog
      )
    ).toMatchObject({
      ok: false,
      error:
        "Parallel lookup exits must share the same target and target handle",
    });
  });

  it("refuses a partial outgoing edge from parallel lookup exits", () => {
    expect(
      analyzeGroupableSelection(
        [lookupA, lookupB],
        [edge("e-a-out", "a", "sms")],
        new Set(["a", "b"]),
        catalog
      )
    ).toMatchObject({
      ok: false,
      error:
        "Parallel lookup exits must share the same target and target handle",
    });
  });

  it("refuses a Condition among multiple exits", () => {
    expect(
      analyzeGroupableSelection(
        [lookupA, condition],
        [
          edge("e-start-a", "life", "a", "started"),
          edge("e-start-c", "life", "c", "started"),
          { ...edge("e-a-out", "a", "sms"), targetHandle: "input" },
          {
            ...edge("e-c-out", "c", "sms", "true"),
            targetHandle: "input",
          },
        ],
        new Set(["a", "c"]),
        catalog
      )
    ).toMatchObject({
      ok: false,
      error: "A Condition must be the only exit step",
    });
  });

  it("refuses Wait and Event Split", () => {
    expect(
      analyzeGroupableSelection(
        [lookupA, wait],
        [edge("e1", "a", "w")],
        new Set(["a", "w"]),
        catalog
      )
    ).toMatchObject({ ok: false, error: "Wait cannot be grouped" });

    expect(
      analyzeGroupableSelection(
        [lookupA, split],
        [edge("e1", "a", "s")],
        new Set(["a", "s"]),
        catalog
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
        new Set(["a", "c"]),
        catalog
      )
    ).toMatchObject({
      ok: false,
      error: "Condition False cannot leave the group",
    });
  });

  it("accepts parallel lookup exits with no outgoing edges", () => {
    expect(
      analyzeGroupableSelection(
        [lookupA, lookupB],
        [],
        new Set(["a", "b"]),
        catalog
      )
    ).toEqual({
      ok: true,
      entryIds: ["a", "b"],
      exitIds: ["a", "b"],
      memberIds: ["a", "b"],
    });
  });

  it("refuses grouping one step", () => {
    expect(
      analyzeGroupableSelection([lookupA], [], new Set(["a"]), catalog)
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
        new Set(["a", "b", "c"]),
        catalog
      )
    ).toMatchObject({
      ok: false,
      error: "Parallel lookups must share the same incoming step",
    });
  });

  it("refuses a step whose action has a side effect", () => {
    expect(
      analyzeGroupableSelection(
        [lookupA, sendEmail],
        [edge("e1", "a", "sms")],
        new Set(["a", "sms"]),
        catalog
      )
    ).toMatchObject({
      ok: false,
      error:
        "A step that changes something outside the workflow stays outside the frame",
    });
  });

  it("accepts an action the catalog does not list, which declares nothing", () => {
    expect(
      analyzeGroupableSelection(
        [action("x", "host/unlisted"), lookupA],
        [edge("e1", "x", "a")],
        new Set(["x", "a"]),
        catalog
      )
    ).toMatchObject({ ok: true });
  });

  it("refuses nodes already inside a group", () => {
    expect(
      analyzeGroupableSelection(
        [
          { ...lookupA, parentId: "g" },
          { ...lookupB, parentId: "g" },
        ],
        [edge("e1", "a", "b")],
        new Set(["a", "b"]),
        catalog
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
      group("g", ["a"], ["c"]),
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

    expect(resolveStoredSources(nodes, "g")).toEqual(["c"]);
    expect(storedTargetsFor(nodes, "g")).toEqual(["a"]);
  });

  // `displayEdgesAtom` recomputes on every node change, a drag frame included,
  // and hands the answer to React Flow as its `edges` prop. A fresh array there
  // rebuilds the whole connection lookup per frame, so a graph with nothing to
  // remap has to come back as the array it went in as.
  it("answers the same array when no edge sits on a frame", () => {
    const nodes: GroupGraphNode[] = [lookupA, lookupB, condition];
    const edges = [edge("ab", "a", "b"), edge("bc", "b", "c")];

    expect(displayEdgesForGroups(nodes, edges)).toBe(edges);
  });

  it("paints an edge between two frames on both frames", () => {
    // Grouping two adjacent chains leaves one stored edge with a member at each
    // end, and the two members answer to different frames. Remapping only the
    // end whose other side is unframed left it naming both children, which the
    // layout below then dropped as if it were interior.
    const nodes: GroupGraphNode[] = [
      group("g1", ["a"], ["b"]),
      { ...lookupA, parentId: "g1" },
      { ...lookupB, parentId: "g1" },
      group("g2", ["c"], ["d"]),
      { ...condition, parentId: "g2" },
      { ...action("d", "fountain/get-user"), parentId: "g2" },
    ];
    const edges = [
      edge("ab", "a", "b"),
      edge("bc", "b", "c"),
      edge("cd", "c", "d"),
    ];

    expect(displayEdgesForGroups(nodes, edges)).toEqual([
      edges[0],
      { ...edges[1], source: "g1", target: "g2" },
      edges[2],
    ]);
    expect(edgesForGroupLayout(nodes, edges).map((item) => item.id)).toEqual([
      "bc",
    ]);
  });

  it("collapses a parallel fan-out onto one painted inlet", () => {
    const nodes: GroupGraphNode[] = [
      action("life", "ignored", {
        data: { type: "lifecycle", label: "Start" },
      }),
      group("g", ["a", "b"], ["c"]),
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

  it("collapses parallel lookup exits and expands their outlet operations", () => {
    const nodes: GroupGraphNode[] = [
      group("g", ["a", "b"], ["a", "b"]),
      { ...lookupA, parentId: "g" },
      { ...lookupB, parentId: "g" },
      action("sms", "resend/send-email"),
      action("next", "resend/send-email"),
    ];
    const edges = [
      { ...edge("out-a", "a", "sms"), targetHandle: "input" },
      { ...edge("out-b", "b", "sms"), targetHandle: "input" },
    ];

    expect(displayEdgesForGroups(nodes, edges)).toEqual([
      { ...edges[0], source: "g" },
    ]);
    expect(resolveStoredSources(nodes, "g")).toEqual(["a", "b"]);
    expect(fanOutStoreEdgeIds(nodes, edges, "out-a")).toEqual([
      "out-a",
      "out-b",
    ]);
    expect(
      fanOutStoreEdges({
        nodes,
        edges,
        sourceId: "g",
        targetId: "next",
        sourceHandle: undefined,
      })
    ).toEqual([
      { source: "a", target: "next", sourceHandle: undefined },
      { source: "b", target: "next", sourceHandle: undefined },
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
      group("g", ["a"], ["c"]),
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
    expect(isGroupNode(group("g", ["a"], ["c"]))).toBe(true);
    expect(isGroupNode(lookupA)).toBe(false);
  });
});

describe("undersizedGroupIds", () => {
  it("names a group that no longer holds two children", () => {
    const nodes = [group("g", ["a"], ["c"]), { ...lookupA, parentId: "g" }];
    expect(undersizedGroupIds(nodes)).toEqual(["g"]);
  });
});

describe("groupOutletHandle", () => {
  it("reads the baked Condition outlet and ignores an absent one", () => {
    expect(groupOutletHandle(group("g", ["a"], ["c"], "true"))).toBe("true");
    expect(groupOutletHandle(group("g", ["a"], ["c"]))).toBeUndefined();
  });
});

describe("orderGroupParentsFirst", () => {
  it("returns the same array when rest, groups, and children are already ordered", () => {
    const nodes = [
      action("life", "ignored", {
        data: { type: "lifecycle", label: "Start" },
      }),
      group("g", ["a"], ["c"]),
      { ...lookupA, parentId: "g" },
    ];
    expect(orderGroupParentsFirst(nodes)).toBe(nodes);
  });

  it("reorders when a child sits before its group", () => {
    const child = { ...lookupA, parentId: "g" };
    const frame = group("g", ["a"], ["c"]);
    const rest = action("sms", "resend/send-email");
    expect(orderGroupParentsFirst([child, rest, frame])).toEqual([
      rest,
      frame,
      child,
    ]);
  });
});
