import { uniq } from "es-toolkit/array";
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
  groupEndPorts,
  groupOutlets,
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
import { groupPortKey } from "#src/graph/group-port-key";
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

  describe("branches converging on a join", () => {
    type Box = { left: number; top: number; right: number; bottom: number };
    type Segment = { x1: number; y1: number; x2: number; y2: number };

    /** Member ids and interior edges written as "source>target" pairs. */
    function shape(...pairs: string[]) {
      const interiorEdges = pairs.map((pair) => {
        const [source = "", target = ""] = pair.split(">");
        return edge(pair, source, target);
      });
      const memberIds = uniq(
        interiorEdges.flatMap((item) => [item.source, item.target])
      );
      return { memberIds, interiorEdges };
    }

    const shapes = {
      "two equal arms": shape("a>b", "a>c", "b>j", "c>j"),
      "uneven arms": shape("a>b", "b>b2", "b2>b3", "a>c", "b3>j", "c>j"),
      "the fan-out's own edge beside a long arm": shape(
        "a>b",
        "b>b2",
        "b2>j",
        "a>j"
      ),
      "three arms of different lengths": shape(
        "a>b",
        "a>c",
        "c>c2",
        "a>d",
        "d>d2",
        "d2>d3",
        "b>j",
        "c2>j",
        "d3>j"
      ),
      "two joins in a row": shape(
        "a>b",
        "a>c",
        "b>j",
        "c>j",
        "j>k",
        "j>m",
        "m>m2",
        "k>n",
        "m2>n"
      ),
      "entries from outside joining after a long arm": shape(
        "a>j",
        "b>b2",
        "b2>b3",
        "b3>j"
      ),
    };

    /** A card's box, at the standard card size in either direction. */
    function boxOf(position: { x: number; y: number }): Box {
      return {
        left: position.x,
        top: position.y,
        right: position.x + W,
        bottom: position.y + H,
      };
    }

    /**
     * The three segments the canvas draws for an edge between two boxes: out of
     * the source along the flow, across in the middle of the rank gap before
     * the target, and into the target. `edge-path.ts` turns edges there.
     */
    function route(
      source: Box,
      target: Box,
      direction: "vertical" | "horizontal"
    ): Segment[] {
      if (direction === "vertical") {
        const sx = (source.left + source.right) / 2;
        const tx = (target.left + target.right) / 2;
        const turn = Math.max(
          (source.bottom + target.top) / 2,
          target.top - RANK_SPACING / 2
        );
        return [
          { x1: sx, y1: source.bottom, x2: sx, y2: turn },
          { x1: sx, y1: turn, x2: tx, y2: turn },
          { x1: tx, y1: turn, x2: tx, y2: target.top },
        ];
      }
      const sy = (source.top + source.bottom) / 2;
      const ty = (target.top + target.bottom) / 2;
      const turn = Math.max(
        (source.right + target.left) / 2,
        target.left - RANK_SPACING / 2
      );
      return [
        { x1: source.right, y1: sy, x2: turn, y2: sy },
        { x1: turn, y1: sy, x2: turn, y2: ty },
        { x1: turn, y1: ty, x2: target.left, y2: ty },
      ];
    }

    function crosses(segment: Segment, box: Box): boolean {
      const left = Math.min(segment.x1, segment.x2);
      const right = Math.max(segment.x1, segment.x2);
      const top = Math.min(segment.y1, segment.y2);
      const bottom = Math.max(segment.y1, segment.y2);
      return (
        left < box.right &&
        right > box.left &&
        top < box.bottom &&
        bottom > box.top
      );
    }

    function overlaps(a: Box, b: Box): boolean {
      return (
        a.left < b.right &&
        a.right > b.left &&
        a.top < b.bottom &&
        a.bottom > b.top
      );
    }

    const cases = Object.entries(shapes).flatMap(([name, graph]) =>
      (["vertical", "horizontal"] as const).map((direction) => ({
        name,
        direction,
        ...graph,
      }))
    );

    it.each(cases)(
      "$name in a $direction Group: each join follows its predecessors, no cards overlap, and no edge crosses a card",
      ({ memberIds, interiorEdges, direction }) => {
        const positions = groupCanvasPositions({
          memberIds,
          interiorEdges,
          direction,
        });
        const box = (id: string) => {
          const position = positions.get(id);
          if (!position) {
            throw new Error(`no position for ${id}`);
          }
          return boxOf(position);
        };

        for (const item of interiorEdges) {
          const source = box(item.source);
          const target = box(item.target);
          if (direction === "vertical") {
            expect(target.top).toBeGreaterThanOrEqual(
              source.bottom + RANK_SPACING
            );
          } else {
            expect(target.left).toBeGreaterThanOrEqual(
              source.right + RANK_SPACING
            );
          }
        }

        for (const [index, id] of memberIds.entries()) {
          for (const other of memberIds.slice(index + 1)) {
            expect(overlaps(box(id), box(other))).toBe(false);
          }
        }

        for (const item of interiorEdges) {
          const segments = route(box(item.source), box(item.target), direction);
          for (const id of memberIds) {
            if (id === item.source || id === item.target) {
              continue;
            }
            for (const segment of segments) {
              expect(
                crosses(segment, box(id)),
                `${item.id} crosses ${id}`
              ).toBe(false);
            }
          }
        }
      }
    );

    it("keeps a lane clear from an early continuation to the stubs after the last row", () => {
      const { memberIds, interiorEdges } = shape("a>b", "b>c");
      const laneOf = (positions: Map<string, { x: number; y: number }>) =>
        (positions.get("a")?.x ?? 0) + W / 2;
      const covers = (
        positions: Map<string, { x: number; y: number }>,
        id: string
      ) => {
        const card = boxOf(positions.get(id) ?? { x: 0, y: 0 });
        const lane = laneOf(positions);
        return lane > card.left && lane < card.right;
      };

      const stacked = groupCanvasPositions({ memberIds, interiorEdges });
      expect(covers(stacked, "b")).toBe(true);

      const positions = groupCanvasPositions({
        memberIds,
        interiorEdges,
        trailingStubPorts: [{ nodeId: "a", handle: null }],
      });
      expect(covers(positions, "b")).toBe(false);
      expect(covers(positions, "c")).toBe(false);
    });
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

describe("groupOutlets", () => {
  const conditionGroup: GroupGraphNode[] = [
    group("g"),
    { ...lookupA, parentId: "g" },
    { ...condition, parentId: "g" },
    action("sms", "resend/send-email"),
  ];
  const handleOf = (outlets: ReturnType<typeof groupOutlets>, label: string) =>
    outlets.find((outlet) => outlet.label === label)?.handleId;

  it("draws the handle the Group's continuation already uses", () => {
    expect(
      groupOutlets(
        conditionGroup,
        [edge("ac", "a", "c"), edge("out", "c", "sms", "true")],
        "g"
      )
    ).toEqual([
      {
        handleId: "true",
        label: "True",
        ports: [{ nodeId: "c", handle: "true" }],
        continues: true,
      },
    ]);
  });

  it("keeps the continuing branch when the other branch ends inside the Group", () => {
    const nodes = [...conditionGroup, { ...lookupB, parentId: "g" }];
    const edges = [
      edge("ac", "a", "c"),
      edge("out", "c", "sms", "false"),
      edge("in", "c", "b", "true"),
    ];
    expect(
      groupOutlets(nodes, edges, "g").map((item) => item.handleId)
    ).toEqual(["false"]);
    expect(
      resolveStoredSources({
        nodes,
        edges,
        sourceId: "g",
        sourceHandle: "false",
      })
    ).toEqual([{ source: "c", sourceHandle: "false" }]);
  });

  it("draws a labelled handle per end port while nothing leaves the Group", () => {
    const nodes = [...conditionGroup, { ...lookupB, parentId: "g" }];
    const outlets = groupOutlets(nodes, [edge("ac", "a", "c")], "g");

    expect(outlets.map((item) => [item.label, item.ports])).toEqual([
      ["True", [{ nodeId: "c", handle: "true" }]],
      ["False", [{ nodeId: "c", handle: "false" }]],
      ["b", [{ nodeId: "b", handle: null }]],
    ]);
    expect(new Set(outlets.map((item) => item.handleId)).size).toBe(3);
  });

  it("draws a distinct handle per end port when member ids hold a lone surrogate or the separator characters", () => {
    const memberIds = ["\ud800", "x/y", "x", "x%2Fy"];
    const nodes: GroupGraphNode[] = [
      group("g"),
      ...memberIds.map((id) => ({
        ...action(id, "fountain/get-user"),
        parentId: "g",
      })),
    ];

    const outlets = groupOutlets(nodes, [], "g");

    expect(outlets.map((item) => item.handleId)).toEqual(
      memberIds.map((nodeId) => `end:${groupPortKey({ nodeId, handle: null })}`)
    );
    expect(new Set(outlets.map((item) => item.handleId)).size).toBe(
      memberIds.length
    );
  });

  it("names each plain end port with the title `titleOf` gives its member", () => {
    const nodes: GroupGraphNode[] = [
      group("g"),
      { ...action("m1", "clerk/get-user"), parentId: "g" },
      { ...action("m2", "linear/find-issues"), parentId: "g" },
    ].map((node) =>
      node.id === "g" ? node : { ...node, data: { ...node.data, label: "" } }
    );
    const titles: Record<string, string> = {
      m1: "Get User",
      m2: "Find Issues",
    };

    expect(
      groupOutlets(nodes, [], "g", (node) => titles[node.id] ?? node.id).map(
        (item) => item.label
      )
    ).toEqual(["Get User", "Find Issues"]);
  });

  it("leaves a lone plain end port unlabelled", () => {
    const nodes: GroupGraphNode[] = [
      group("g"),
      { ...lookupA, parentId: "g" },
      { ...lookupB, parentId: "g" },
    ];
    expect(
      groupOutlets(nodes, [edge("ab", "a", "b")], "g").map((item) => item.label)
    ).toEqual([null]);
  });

  it("stores one continuation from the True handle when False ends at a member", () => {
    const nodes: GroupGraphNode[] = [
      ...conditionGroup,
      { ...lookupB, parentId: "g" },
    ];
    const edges = [edge("ac", "a", "c"), edge("cb", "c", "b", "false")];
    const outlets = groupOutlets(nodes, edges, "g");

    expect(outlets.map((item) => item.label)).toEqual(["True", "b"]);
    expect(
      fanOutStoreEdges({
        nodes,
        edges,
        sourceId: "g",
        targetId: "sms",
        sourceHandle: handleOf(outlets, "True"),
      })
    ).toEqual([{ source: "c", target: "sms", sourceHandle: "true" }]);
  });

  it("stores one continuation from the handle a drag starts on when both branches end inside", () => {
    const outlets = groupOutlets(conditionGroup, [edge("ac", "a", "c")], "g");

    expect(
      fanOutStoreEdges({
        nodes: conditionGroup,
        edges: [edge("ac", "a", "c")],
        sourceId: "g",
        targetId: "sms",
        sourceHandle: handleOf(outlets, "False"),
      })
    ).toEqual([{ source: "c", target: "sms", sourceHandle: "false" }]);
  });

  it("draws one unlabelled handle standing for no port for an id that is not a Group", () => {
    expect(groupOutlets(conditionGroup, [edge("ac", "a", "c")], "sms")).toEqual(
      [{ handleId: null, label: null, ports: [], continues: false }]
    );
  });

  it("draws one handle per distinct handle the Group's continuation uses", () => {
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

    expect(
      groupOutlets(nodes, edges, "g").map((item) => item.handleId)
    ).toEqual([null, "true"]);
  });
});

describe("fanOutStoreEdges through a frame outlet", () => {
  it("stores from the continuing ports of the handle the connection names", () => {
    const nodes: GroupGraphNode[] = [
      group("g"),
      { ...lookupB, parentId: "g" },
      { ...condition, parentId: "g" },
      action("x", "resend/send-email"),
      action("y", "resend/send-email"),
      action("z", "resend/send-email"),
    ];
    const edges = [edge("by", "b", "y"), edge("cx", "c", "x", "true")];
    const connect = (sourceHandle: string | null) =>
      fanOutStoreEdges({
        nodes,
        edges,
        sourceId: "g",
        targetId: "z",
        sourceHandle,
      });

    expect(connect("true")).toEqual([
      { source: "c", target: "z", sourceHandle: "true" },
    ]);
    expect(connect(null)).toEqual([
      { source: "b", target: "z", sourceHandle: undefined },
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
