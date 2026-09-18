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
  groupEndPorts,
  groupOutlet,
  orderGroupParentsFirst,
  resolveStoredSources,
  storedTargetsFor,
  undersizedGroupIds,
} from "#src/graph/node-group";
import {
  analyzeGroupBoundaryById,
  type GroupGraphNode,
  isGroupNode,
} from "#src/graph/group-boundary";
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

  it("refuses a selection that continues from two outlets to two outside steps", () => {
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
      error: "The steps must continue to one outside step",
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
      {
        ...edges[3],
        source: "g",
        sourceHandle: null,
        data: { displayLabel: "True" },
      },
    ]);

    expect(edgesForGroupLayout(nodes, edges).map((item) => item.id)).toEqual([
      "in",
      "out",
    ]);

    expect(
      resolveStoredSources({
        nodes,
        edges,
        sourceId: "g",
        sourceHandle: "true",
      })
    ).toEqual([{ source: "c", sourceHandle: "true" }]);
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
      { ...edges[1], source: "g1", sourceHandle: null, target: "g2" },
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
      { ...edges[0], source: "g", sourceHandle: null },
    ]);
    expect(
      resolveStoredSources({ nodes, edges, sourceId: "g", sourceHandle: null })
    ).toEqual([
      { source: "a", sourceHandle: undefined },
      { source: "b", sourceHandle: undefined },
    ]);
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

describe("groupEndPorts", () => {
  const ports = (nodes: GroupGraphNode[], edges: WorkflowEdge[]) =>
    groupEndPorts({
      nodes,
      boundary: analyzeGroupBoundaryById({ nodes, edges, groupId: "g" }),
    });

  it("names each member nothing leaves and each unwired Condition outlet", () => {
    const nodes: GroupGraphNode[] = [
      group("g"),
      { ...lookupA, parentId: "g" },
      { ...condition, parentId: "g" },
      { ...lookupB, parentId: "g" },
      action("sms", "resend/send-email"),
    ];

    expect(ports(nodes, [edge("ac", "a", "c")])).toEqual([
      { nodeId: "c", handle: "true" },
      { nodeId: "c", handle: "false" },
      { nodeId: "b", handle: null },
    ]);
    expect(
      ports(nodes, [
        edge("ac", "a", "c"),
        edge("out", "c", "sms", "true"),
        edge("cb", "c", "b", "false"),
      ])
    ).toEqual([{ nodeId: "b", handle: null }]);
  });

  it("reads a member id that names a prototype member as an ordinary id", () => {
    const nodes: GroupGraphNode[] = [
      group("g"),
      { ...lookupA, id: "constructor", parentId: "g" },
      { ...lookupB, id: "__proto__", parentId: "g" },
    ];

    expect(ports(nodes, [edge("e", "constructor", "__proto__")])).toEqual([
      { nodeId: "__proto__", handle: null },
    ]);
  });
});

describe("groupOutlet", () => {
  const conditionGroup: GroupGraphNode[] = [
    group("g"),
    { ...lookupA, parentId: "g" },
    { ...condition, parentId: "g" },
    action("sms", "resend/send-email"),
  ];

  it("stands for the ports the Group's continuation already leaves by", () => {
    expect(
      groupOutlet(
        conditionGroup,
        [edge("ac", "a", "c"), edge("out", "c", "sms", "true")],
        "g"
      )
    ).toEqual({ ports: [{ nodeId: "c", handle: "true" }], continues: true });
  });

  it("stands for both path ends of two parallel members while nothing leaves the Group", () => {
    const nodes: GroupGraphNode[] = [
      action("life", "ignored", {
        data: { type: "lifecycle", label: "Start" },
      }),
      group("g"),
      { ...action("user", "clerk/get-user"), parentId: "g" },
      { ...action("issues", "linear/find-issues"), parentId: "g" },
      action("notify", "resend/send-email"),
    ];
    const edges = [
      edge("in-user", "life", "user", "started"),
      edge("in-issues", "life", "issues", "started"),
    ];

    expect(groupOutlet(nodes, edges, "g")).toEqual({
      ports: [
        { nodeId: "user", handle: null },
        { nodeId: "issues", handle: null },
      ],
      continues: false,
    });
    expect(
      fanOutStoreEdges({
        nodes,
        edges,
        sourceId: "g",
        targetId: "notify",
        sourceHandle: null,
      })
    ).toEqual([
      { source: "user", target: "notify", sourceHandle: undefined },
      { source: "issues", target: "notify", sourceHandle: undefined },
    ]);
  });

  it("continues from terminal steps without wiring unused Condition branches", () => {
    const nodes = [...conditionGroup, { ...lookupB, parentId: "g" }];

    expect(groupOutlet(nodes, [edge("ac", "a", "c")], "g").ports).toEqual([
      { nodeId: "b", handle: null },
    ]);
    expect(
      fanOutStoreEdges({
        nodes,
        edges: [edge("ac", "a", "c")],
        sourceId: "g",
        targetId: "sms",
        sourceHandle: null,
      })
    ).toEqual([{ source: "b", target: "sms", sourceHandle: undefined }]);
  });

  it("offers no continuation when only unused Condition outlets remain", () => {
    expect(groupOutlet(conditionGroup, [edge("ac", "a", "c")], "g")).toEqual({
      ports: [],
      continues: false,
    });
  });

  it("ignores the handle a connection names, since the card has one outlet", () => {
    const nodes = [...conditionGroup, { ...lookupB, parentId: "g" }];
    const edges = [edge("ac", "a", "c"), edge("cb", "c", "b", "false")];

    expect(
      resolveStoredSources({
        nodes,
        edges,
        sourceId: "g",
        sourceHandle: "true",
      })
    ).toEqual(
      resolveStoredSources({ nodes, edges, sourceId: "g", sourceHandle: null })
    );
  });

  it("stands for no port for an id that is not a Group", () => {
    expect(groupOutlet(conditionGroup, [edge("ac", "a", "c")], "sms")).toEqual({
      ports: [],
      continues: false,
    });
  });
});

describe("displayEdgesForGroups on the card's one outlet", () => {
  const nodes: GroupGraphNode[] = [
    group("g"),
    { ...lookupA, parentId: "g" },
    { ...condition, parentId: "g" },
    action("x", "resend/send-email"),
  ];

  it("paints every continuation to one step as one edge, and deleting it names each stored edge", () => {
    const edges = [
      edge("a-x", "a", "x"),
      edge("c-x", "c", "x", "true"),
      edge("c-x-false", "c", "x", "false"),
    ];

    expect(displayEdgesForGroups(nodes, edges)).toEqual([
      { ...edges[0], source: "g", sourceHandle: null },
    ]);
    expect(fanOutStoreEdgeIds(nodes, edges, "c-x")).toEqual([
      "a-x",
      "c-x",
      "c-x-false",
    ]);
  });

  it("names the Condition branch on the painted edge when it is the only one", () => {
    const edges = [edge("c-x", "c", "x", "true")];

    expect(displayEdgesForGroups(nodes, edges)).toEqual([
      {
        ...edges[0],
        source: "g",
        sourceHandle: null,
        data: { displayLabel: "True" },
      },
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
