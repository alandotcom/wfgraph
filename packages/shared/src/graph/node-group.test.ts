import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import { groupContractMatrix } from "#src/graph/group-contract-test-support";
import {
  analyzeGroupableSelection,
  displayEdgesForGroups,
  edgesForGroupLayout,
  expandGroupCopyIds,
  fanOutStoreEdgeIds,
  fanOutStoreEdges,
  groupCanvasPositions,
  groupLayoutDirection,
  groupMemberSlots,
  groupOutletHandle,
  groupOutletHandles,
  orderGroupParentsFirst,
  resolveStoredSources,
  storedTargetsFor,
  undersizedGroupIds,
} from "#src/graph/node-group";
import { type GroupGraphNode, isGroupNode } from "#src/graph/group-boundary";
import type { WorkflowEdge } from "#src/graph/types";
import {
  NODE_SPACING,
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/graph/workflow-layout-geometry";

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

function group(id: string): GroupGraphNode {
  return { id, data: { type: "group", label: "Group" } };
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

describe("analyzeGroupableSelection", () => {
  function analyze(
    nodes: GroupGraphNode[],
    edges: WorkflowEdge[],
    ids: string[]
  ) {
    return analyzeGroupableSelection({
      nodes,
      edges,
      selectedIds: new Set(ids),
    });
  }

  it("accepts a linear chain of a lookup, a side-effecting action and a Wait", () => {
    expect(
      analyze(
        [lookupA, sendEmail, wait, lookupB],
        [
          edge("e-in", "life", "a", "started"),
          edge("e1", "a", "sms"),
          edge("e2", "sms", "w"),
          edge("e-out", "w", "b"),
        ],
        ["w", "sms", "a"]
      )
    ).toEqual({ ok: true, memberIds: ["a", "sms", "w"] });
  });

  it("accepts a chain that ends on a Condition whose True branch continues", () => {
    expect(
      analyze(
        [lookupA, condition],
        [edge("e1", "a", "c"), edge("e-true", "c", "sms", "true")],
        ["a", "c"]
      )
    ).toEqual({ ok: true, memberIds: ["a", "c"] });
  });

  it("refuses a selection entered from two outlets outside it", () => {
    expect(
      analyze(
        [lookupA, lookupB],
        [edge("e1", "life", "a", "started"), edge("e2", "w", "b")],
        ["a", "b"]
      )
    ).toEqual({
      ok: false,
      error: "The steps must be entered from one outlet",
    });
  });

  it("refuses a selection that continues from two outlets inside it", () => {
    expect(
      analyze(
        [lookupA, condition],
        [
          edge("e1", "a", "c"),
          edge("e-true", "c", "sms", "true"),
          edge("e-false", "c", "cancel", "false"),
        ],
        ["a", "c"]
      )
    ).toEqual({
      ok: false,
      error: "The steps must continue from one outlet",
    });
  });

  it("refuses an Event Split", () => {
    expect(
      analyze(
        [lookupA, lookupB, split],
        [edge("e1", "a", "s")],
        ["a", "b", "s"]
      )
    ).toEqual({ ok: false, error: "Event Split cannot be grouped" });
  });

  it("names the Event Split when it is one of several reasons", () => {
    expect(
      analyze([lookupA, split], [edge("e1", "a", "s")], ["a", "s"])
    ).toEqual({ ok: false, error: "Event Split cannot be grouped" });
  });

  it("asks for every branch into a join to start inside the Group", () => {
    const joinStep = action("j", "fountain/get-user");
    expect(
      analyze(
        [action("s0", "fountain/get-user"), lookupA, joinStep, sendEmail],
        [
          edge("e-sa", "s0", "a"),
          edge("e-sj", "s0", "j"),
          edge("e-aj", "a", "j"),
          edge("e-out", "j", "sms"),
        ],
        ["a", "j"]
      )
    ).toEqual({
      ok: false,
      error: "Every branch into the join must start inside the Group",
    });
  });

  it("refuses one step, an unknown id, and a node that is not a step", () => {
    expect(analyze([lookupA], [], ["a"])).toEqual({
      ok: false,
      error: "Select at least two steps",
    });
    expect(analyze([lookupA], [], ["a", "ghost"])).toEqual({
      ok: false,
      error: "Select at least two steps",
    });
    expect(analyze([lookupA, group("g")], [], ["a", "g"])).toEqual({
      ok: false,
      error: "Only steps can be grouped",
    });
  });

  it("refuses steps already inside a group", () => {
    expect(
      analyze(
        [
          { ...lookupA, parentId: "g" },
          { ...lookupB, parentId: "g" },
        ],
        [edge("e1", "a", "b")],
        ["a", "b"]
      )
    ).toEqual({ ok: false, error: "Already in a group" });
  });

  // The grouping policy is the Publish contract applied to the would-be Group,
  // so each matrix Group, taken apart and selected again, is groupable exactly
  // when the contract reports no rule for it.
  it.each(
    groupContractMatrix.filter(
      (item) =>
        item.savesAsDraft &&
        item.nodes.every(
          (node) => node.parentId === undefined || node.data.type === "action"
        )
    )
  )("agrees with the Group contract for $name", (item) => {
    const memberIds = item.nodes
      .filter((node) => node.parentId !== undefined)
      .map((node) => node.id);
    const result = analyze(
      item.nodes
        .filter((node) => !isGroupNode(node))
        .map(({ parentId: _parentId, ...node }) => node),
      item.edges,
      memberIds
    );

    expect(result.ok).toBe(item.rules.length === 0);
  });
});

describe("display and store endpoints", () => {
  it("paints boundary edges on the group frame", () => {
    const nodes: GroupGraphNode[] = [
      action("life", "ignored", {
        data: { type: "lifecycle", label: "Start" },
      }),
      group("g"),
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

    expect(resolveStoredSources(nodes, edges, "g")).toEqual(["c"]);
    expect(storedTargetsFor(nodes, edges, "g")).toEqual(["a"]);
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
      group("g1"),
      { ...lookupA, parentId: "g1" },
      { ...lookupB, parentId: "g1" },
      group("g2"),
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
      group("g"),
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
    expect(storedTargetsFor(nodes, edges, "g")).toEqual(["a", "b"]);
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
    // With no stored edge entering the Group yet, the inlet stands for the
    // members no stored edge enters.
    expect(
      fanOutStoreEdges({
        nodes,
        edges: [edge("a-c", "a", "c"), edge("b-c", "b", "c")],
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
      group("g"),
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
    expect(resolveStoredSources(nodes, edges, "g")).toEqual(["a", "b"]);
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
        [edge("e-a", "a", "c"), edge("e-b", "b", "c")]
      )
    ).toEqual([
      { id: "a", row: 0, column: 0 },
      { id: "b", row: 0, column: 1 },
      { id: "c", row: 1, column: 0 },
    ]);
  });
});

describe("groupCanvasPositions", () => {
  const W = WORKFLOW_NODE_WIDTH;
  const H = WORKFLOW_NODE_HEIGHT;

  it("starts at the collapsed card's slot and centres each row on it", () => {
    const positions = groupCanvasPositions({
      memberIds: ["a", "b", "c", "d"],
      interiorEdges: [
        edge("e-a", "a", "d"),
        edge("e-b", "b", "d"),
        edge("e-c", "c", "d"),
      ],
    });
    const column = W + NODE_SPACING;
    expect(positions).toEqual(
      new Map([
        ["a", { x: -column - W / 2, y: 0 }],
        ["b", { x: -W / 2, y: 0 }],
        ["c", { x: column - W / 2, y: 0 }],
        ["d", { x: -W / 2, y: H + RANK_SPACING }],
      ])
    );
  });

  it("puts a lone member exactly on the card in either direction", () => {
    for (const direction of ["vertical", "horizontal"] as const) {
      expect(
        groupCanvasPositions({ memberIds: ["a"], interiorEdges: [], direction })
      ).toEqual(new Map([["a", { x: -W / 2, y: 0 }]]));
    }
  });

  it("lays rows left to right when horizontal", () => {
    const positions = groupCanvasPositions({
      memberIds: ["a", "b"],
      interiorEdges: [edge("e-a", "a", "b")],
      direction: "horizontal",
    });
    expect(positions.get("b")).toEqual({
      x: W + RANK_SPACING - W / 2,
      y: 0,
    });
  });
});

describe("expandGroupCopyIds", () => {
  it("takes the frame and every child when either is selected", () => {
    const nodes = [
      group("g"),
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
    expect(isGroupNode(group("g"))).toBe(true);
    expect(isGroupNode(lookupA)).toBe(false);
  });
});

describe("undersizedGroupIds", () => {
  it("names a group that no longer holds two children", () => {
    const nodes = [group("g"), { ...lookupA, parentId: "g" }];
    expect(undersizedGroupIds(nodes)).toEqual(["g"]);
  });

  it("counts the children of a group whose id names a prototype member", () => {
    // A plain-object counter answers `constructor` with Object itself, and the
    // comparison against it is never true, so such a group would go unnamed.
    const nodes = [
      group("constructor"),
      { ...lookupA, parentId: "constructor" },
    ];
    expect(undersizedGroupIds(nodes)).toEqual(["constructor"]);
  });

  it("counts an Event Split member as no step, as Publish does", () => {
    const nodes = [
      group("g"),
      { ...lookupA, parentId: "g" },
      { ...split, parentId: "g" },
      group("h"),
      { ...lookupB, parentId: "h" },
      { ...condition, parentId: "h" },
    ];
    expect(undersizedGroupIds(nodes)).toEqual(["g"]);
  });
});

describe("groupOutletHandle", () => {
  const conditionGroup: GroupGraphNode[] = [
    group("g"),
    { ...lookupA, parentId: "g" },
    { ...condition, parentId: "g" },
    action("sms", "resend/send-email"),
  ];

  it("names the handle the Group's continuation already uses", () => {
    expect(
      groupOutletHandle(
        conditionGroup,
        [edge("ac", "a", "c"), edge("out", "c", "sms", "true")],
        "g"
      )
    ).toBe("true");
  });

  it("names True for a Condition exit before anything leaves the Group", () => {
    expect(groupOutletHandle(conditionGroup, [edge("ac", "a", "c")], "g")).toBe(
      "true"
    );
  });

  it("names no handle when a Condition is one of several exits", () => {
    expect(
      groupOutletHandle(
        [...conditionGroup, { ...lookupB, parentId: "g" }],
        [edge("ac", "a", "c")],
        "g"
      )
    ).toBeUndefined();
  });

  it("names no handle for an id that is not a Group", () => {
    expect(
      groupOutletHandle(conditionGroup, [edge("ac", "a", "c")], "sms")
    ).toBeUndefined();
  });

  it("names no handle for lookup exits", () => {
    const nodes: GroupGraphNode[] = [
      group("g"),
      { ...lookupA, parentId: "g" },
      { ...lookupB, parentId: "g" },
      action("sms", "resend/send-email"),
    ];
    expect(
      groupOutletHandle(
        nodes,
        [edge("ab", "a", "b"), edge("out", "b", "sms")],
        "g"
      )
    ).toBeUndefined();
  });
});

describe("groupOutletHandles", () => {
  it("names every distinct handle the Group's continuation uses", () => {
    const nodes: GroupGraphNode[] = [
      group("g"),
      { ...lookupB, parentId: "g" },
      { ...condition, parentId: "g" },
      action("x", "resend/send-email"),
      action("y", "resend/send-email"),
    ];
    const edges = [
      edge("by", "b", "y"),
      edge("cx", "c", "x", "true"),
      edge("cy", "c", "y", "true"),
    ];

    expect(groupOutletHandles(nodes, edges, "g")).toEqual([null, "true"]);
  });
});

describe("fanOutStoreEdges through a frame outlet", () => {
  it("stores a Condition branch handle only on an exit that is a Condition", () => {
    const nodes: GroupGraphNode[] = [
      group("g"),
      { ...lookupB, parentId: "g" },
      { ...condition, parentId: "g" },
      action("x", "resend/send-email"),
      action("y", "resend/send-email"),
      action("z", "resend/send-email"),
    ];
    const edges = [edge("by", "b", "y"), edge("cx", "c", "x", "true")];

    expect(
      fanOutStoreEdges({
        nodes,
        edges,
        sourceId: "g",
        targetId: "z",
        sourceHandle: "true",
      })
    ).toEqual([
      { source: "b", target: "z", sourceHandle: undefined },
      { source: "c", target: "z", sourceHandle: "true" },
    ]);
  });
});

describe("orderGroupParentsFirst", () => {
  it("returns the same array when rest, groups, and children are already ordered", () => {
    const nodes = [
      action("life", "ignored", {
        data: { type: "lifecycle", label: "Start" },
      }),
      group("g"),
      { ...lookupA, parentId: "g" },
    ];
    expect(orderGroupParentsFirst(nodes)).toBe(nodes);
  });

  it("reorders when a child sits before its group", () => {
    const child = { ...lookupA, parentId: "g" };
    const frame = group("g");
    const rest = action("sms", "resend/send-email");
    expect(orderGroupParentsFirst([child, rest, frame])).toEqual([
      rest,
      frame,
      child,
    ]);
  });
});

describe("groupLayoutDirection", () => {
  it("reads the stored direction and lays out vertically when none is stored", () => {
    const frame = group("g");
    expect(groupLayoutDirection(frame)).toBe("vertical");
    expect(groupLayoutDirection(undefined)).toBe("vertical");
    expect(
      groupLayoutDirection({
        ...frame,
        data: { ...frame.data, config: { direction: "horizontal" } },
      })
    ).toBe("horizontal");
    expect(
      groupLayoutDirection({
        ...frame,
        data: { ...frame.data, config: { direction: "sideways" } },
      })
    ).toBe("vertical");
  });
});
