import { describe, expect, test } from "vitest";
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "#src/lib/workflow-graph-types";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { layoutWorkflowNodes } from "./workflow-layout";
import {
  eventSplitCardWidth,
  groupFrameSize,
  NODE_SPACING,
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";

/**
 * How far a branch sits from the node above it when a sibling column is held
 * open: half the centre-to-centre distance between two standard cards.
 */
const HALF_SIBLING_PITCH = (WORKFLOW_NODE_WIDTH + NODE_SPACING) / 2;

/**
 * An Event Split's outlets are the Events reaching it, which the layout reads
 * through the catalog. These are the two an `EVENT_SPLIT_EVENTS` graph declares.
 */
const CREATED_EVENT = "app/appointment.created";
const RESCHEDULED_EVENT = "app/appointment.rescheduled";
const CONFIRMED_EVENT = "app/appointment.confirmed";

const layoutCatalog: ExtensionCatalog = {
  integrations: [],
  actions: [],
  events: [
    {
      name: CREATED_EVENT,
      label: "Appointment created",
      payloadFields: [],
    },
    {
      name: RESCHEDULED_EVENT,
      label: "Appointment rescheduled",
      payloadFields: [],
    },
    {
      name: CONFIRMED_EVENT,
      label: "Appointment confirmed",
      payloadFields: [],
    },
  ],
};

function buildNode(
  id: string,
  position: { x: number; y: number },
  type: WorkflowNodeType = "action"
): WorkflowNode {
  return {
    id,
    type,
    position,
    data: {
      label: id,
      type,
      status: "idle",
    },
  };
}

/** An entry node whose Started outlet hands on the Events named. */
function buildEntryNode(
  id: string,
  position: { x: number; y: number },
  startEvents: string[]
): WorkflowNode {
  const node = buildNode(id, position, "lifecycle");
  return {
    ...node,
    data: {
      ...node.data,
      config: {
        lifecycleRules: {
          startEvents,
          cancelEvents: [],
          concurrency: "newest-wins",
          allowManualStart: true,
        },
      },
    },
  };
}

function buildConditionNode(
  id: string,
  position: { x: number; y: number }
): WorkflowNode {
  const node = buildNode(id, position);
  return {
    ...node,
    data: {
      ...node.data,
      config: { actionType: BUILT_IN_ACTION_IDS.condition },
    },
  };
}

function buildEventSplitNode(
  id: string,
  position: { x: number; y: number }
): WorkflowNode {
  const node = buildNode(id, position);
  return {
    ...node,
    data: {
      ...node.data,
      config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
    },
  };
}

function buildEdge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return {
    id,
    source,
    target,
    sourceHandle,
  };
}

/**
 * A frame the chain runs through, built from the members and edges given. The
 * layout reads a frame's size off its members, so a case that asserts geometry
 * around one has to hand over the children too.
 */
function buildFramedChain(input: {
  entryIds: string[];
  members: string[];
  interior: WorkflowEdge[];
}): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const group: WorkflowNode = {
    id: "g",
    type: "group",
    position: { x: 0, y: 400 },
    data: {
      label: "Lookups",
      type: "group",
      config: { entryNodeIds: input.entryIds, exitNodeId: "exit" },
    },
  };
  const children = input.members.map((id, index) => ({
    ...buildNode(id, { x: 12, y: 48 + index * 64 }),
    parentId: "g",
    extent: "parent" as const,
  }));

  return {
    nodes: [
      buildNode("entry", { x: 0, y: 0 }, "lifecycle"),
      buildNode("wait", { x: 0, y: 200 }),
      group,
      ...children,
      buildNode("sms", { x: 0, y: 700 }),
    ],
    edges: [
      buildEdge("e1", "entry", "wait", "started"),
      ...input.entryIds.map((id, index) =>
        buildEdge(`in-${index}`, "wait", id)
      ),
      ...input.interior,
      buildEdge("out", "exit", "sms"),
    ],
  };
}

function findNode(nodes: WorkflowNode[], id: string): WorkflowNode {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) {
    throw new Error(`no node ${id} in the layout result`);
  }

  return node;
}

function positionX(nodes: WorkflowNode[], id: string): number {
  return findNode(nodes, id).position.x;
}

function positionY(nodes: WorkflowNode[], id: string): number {
  return findNode(nodes, id).position.y;
}

/** The card's own centre, which is what a column is measured from. */
function centerX(nodes: WorkflowNode[], id: string, width: number): number {
  return positionX(nodes, id) + width / 2;
}

describe("layoutWorkflowNodes", () => {
  test("returns unchanged result when no nodes exist", async () => {
    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes: [],
      edges: [],
    });
    expect(result.changed).toBe(false);
    expect(result.nodes).toEqual([]);
  });

  test("keeps canonical single-node position unchanged", async () => {
    const nodes = [buildNode("a", { x: 40, y: 40 })];
    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges: [],
    });
    expect(result.changed).toBe(false);
    expect(result.nodes[0]?.position).toEqual({ x: 40, y: 40 });
  });

  test("is deterministic for the same graph input", async () => {
    const nodes = [
      buildNode("lifecycle", { x: 80, y: 80 }, "lifecycle"),
      buildNode("left", { x: 460, y: 260 }),
      buildNode("right", { x: 620, y: 260 }),
    ];
    const edges = [
      buildEdge("e1", "lifecycle", "left"),
      buildEdge("e2", "lifecycle", "right"),
    ];

    const first = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });
    const second = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes: first.nodes,
      edges,
    });

    expect(second.nodes.map((node) => node.position)).toEqual(
      first.nodes.map((node) => node.position)
    );
  });

  test("puts the Started branch left of the Canceled branch", async () => {
    // The ids sort the other way round, so an id tie-break would flip the two
    // branches and cross both edges under the entry node.
    const nodes = [
      buildNode("lifecycle", { x: 0, y: 0 }, "lifecycle"),
      buildNode("z-started", { x: 0, y: 300 }),
      buildNode("a-canceled", { x: 300, y: 300 }),
    ];
    const edges = [
      buildEdge("e1", "lifecycle", "z-started", "started"),
      buildEdge("e2", "lifecycle", "a-canceled", "canceled"),
    ];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    expect(positionX(result.nodes, "z-started")).toBeLessThan(
      positionX(result.nodes, "a-canceled")
    );
  });

  test("puts the True branch left of the False branch", async () => {
    const nodes = [
      buildNode("lifecycle", { x: 0, y: 0 }, "lifecycle"),
      buildNode("condition", { x: 0, y: 300 }),
      buildNode("z-true", { x: 0, y: 600 }),
      buildNode("a-false", { x: 300, y: 600 }),
    ];
    const edges = [
      buildEdge("e1", "lifecycle", "condition", "started"),
      buildEdge("e2", "condition", "z-true", "true"),
      buildEdge("e3", "condition", "a-false", "false"),
    ];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    expect(positionX(result.nodes, "z-true")).toBeLessThan(
      positionX(result.nodes, "a-false")
    );
  });

  test("falls back to dagre for non-tree graphs", async () => {
    const nodes = [
      buildNode("a", { x: 0, y: 0 }, "lifecycle"),
      buildNode("b", { x: 80, y: 200 }),
      buildNode("c", { x: 220, y: 200 }),
    ];
    const edges = [buildEdge("e1", "a", "c"), buildEdge("e2", "b", "c")];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    expect(result.nodes).toHaveLength(3);
    for (const node of result.nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });

  test("ignores dangling edges and still lays out valid nodes", async () => {
    const nodes = [
      buildNode("a", { x: 140, y: 140 }, "lifecycle"),
      buildNode("b", { x: 340, y: 340 }),
    ];
    const edges = [
      buildEdge("valid", "a", "b"),
      buildEdge("dangling-target", "a", "missing"),
      buildEdge("dangling-source", "missing", "b"),
    ];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });
    expect(result.nodes).toHaveLength(2);
    for (const node of result.nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });

  test("puts a split's children under the outlets that feed them", async () => {
    // The ids sort the other way round, so ordering on one would cross both
    // edges under the split.
    const nodes = [
      buildEntryNode("entry", { x: 0, y: 0 }, [
        CREATED_EVENT,
        RESCHEDULED_EVENT,
      ]),
      buildEventSplitNode("split", { x: 0, y: 300 }),
      buildNode("z-created", { x: 300, y: 600 }),
      buildNode("a-rescheduled", { x: 0, y: 600 }),
    ];
    const edges = [
      buildEdge("e1", "entry", "split", "started"),
      buildEdge("e2", "split", "z-created", eventSplitOutlet(CREATED_EVENT)),
      buildEdge(
        "e3",
        "split",
        "a-rescheduled",
        eventSplitOutlet(RESCHEDULED_EVENT)
      ),
    ];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    expect(positionX(result.nodes, "z-created")).toBeLessThan(
      positionX(result.nodes, "a-rescheduled")
    );
  });

  test.for([
    [CREATED_EVENT, RESCHEDULED_EVENT],
    [CREATED_EVENT, RESCHEDULED_EVENT, CONFIRMED_EVENT],
  ])("leaves a split room for the width it draws at", async (startEvents) => {
    const nodes = [
      buildEntryNode("entry", { x: 0, y: 0 }, startEvents),
      buildEventSplitNode("split", { x: 0, y: 300 }),
      buildNode("sibling", { x: 300, y: 300 }),
    ];
    const edges = [
      buildEdge("e1", "entry", "split", "started"),
      buildEdge("e2", "entry", "sibling", "started"),
    ];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    // The gap between the two left edges covers the split's whole card, so the
    // wider it draws the further its neighbour sits.
    const splitWidth = eventSplitCardWidth(startEvents.length);
    expect(splitWidth).toBeGreaterThan(WORKFLOW_NODE_WIDTH);
    expect(
      positionX(result.nodes, "sibling") - positionX(result.nodes, "split")
    ).toBeGreaterThanOrEqual(splitWidth);
  });

  test("orders two branches off one outlet by where they already sit", async () => {
    // The left-hand target carries the id that sorts later, so a tie broken on
    // an id would swap the pair.
    const nodes = [
      buildNode("entry", { x: 0, y: 0 }, "lifecycle"),
      buildNode("z-left", { x: 0, y: 300 }),
      buildNode("a-right", { x: 400, y: 300 }),
    ];
    const edges = [
      buildEdge("e1", "entry", "a-right", "started"),
      buildEdge("e2", "entry", "z-left", "started"),
    ];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    expect(positionX(result.nodes, "z-left")).toBeLessThan(
      positionX(result.nodes, "a-right")
    );
  });

  test("orders two branches sitting at one place by how they were wired", async () => {
    const buildGraph = (firstTarget: string, secondTarget: string) => ({
      catalog: layoutCatalog,
      nodes: [
        buildNode("entry", { x: 0, y: 0 }, "lifecycle"),
        buildNode("one", { x: 200, y: 300 }),
        buildNode("two", { x: 200, y: 300 }),
      ],
      edges: [
        buildEdge("e1", "entry", firstTarget, "started"),
        buildEdge("e2", "entry", secondTarget, "started"),
      ],
    });

    const wiredOneFirst = await layoutWorkflowNodes(buildGraph("one", "two"));
    expect(positionX(wiredOneFirst.nodes, "one")).toBeLessThan(
      positionX(wiredOneFirst.nodes, "two")
    );

    const wiredTwoFirst = await layoutWorkflowNodes(buildGraph("two", "one"));
    expect(positionX(wiredTwoFirst.nodes, "two")).toBeLessThan(
      positionX(wiredTwoFirst.nodes, "one")
    );
  });

  test("centres a parent over its children", async () => {
    const nodes = [
      buildNode("entry", { x: 0, y: 0 }, "lifecycle"),
      buildNode("left", { x: 0, y: 300 }),
      buildNode("right", { x: 400, y: 300 }),
    ];
    const edges = [
      buildEdge("e1", "entry", "left", "started"),
      buildEdge("e2", "entry", "right", "canceled"),
    ];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    expect(positionX(result.nodes, "entry")).toBeGreaterThan(
      positionX(result.nodes, "left")
    );
    expect(positionX(result.nodes, "entry")).toBeLessThan(
      positionX(result.nodes, "right")
    );
  });

  test("centres a parent over its children on the dagre path too", async () => {
    // The join is what sends this graph down the fallback. Which of the two
    // branches lands left is dagre's own ordering pass to decide, so the case
    // asks only that the parent sits between them.
    const nodes = [
      buildNode("entry", { x: 0, y: 0 }, "lifecycle"),
      buildNode("left", { x: 0, y: 300 }),
      buildNode("right", { x: 400, y: 300 }),
      buildNode("join", { x: 200, y: 600 }),
    ];
    const edges = [
      buildEdge("e1", "entry", "left", "started"),
      buildEdge("e2", "entry", "right", "canceled"),
      buildEdge("e3", "left", "join"),
      buildEdge("e4", "right", "join"),
    ];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    const branches = [
      positionX(result.nodes, "left"),
      positionX(result.nodes, "right"),
    ];
    expect(positionX(result.nodes, "entry")).toBeGreaterThan(
      Math.min(...branches)
    );
    expect(positionX(result.nodes, "entry")).toBeLessThan(
      Math.max(...branches)
    );
  });

  test("lays out the same shape the same way whatever the ids are", async () => {
    const buildGraph = (suffix: string, join: boolean) => {
      const id = (name: string) => `${name}${suffix}`;
      return {
        catalog: layoutCatalog,
        nodes: [
          buildNode(id("entry"), { x: 0, y: 0 }, "lifecycle"),
          buildNode(id("left"), { x: 0, y: 300 }),
          buildNode(id("right"), { x: 400, y: 300 }),
          buildNode(id("last"), { x: 200, y: 600 }),
        ],
        edges: [
          buildEdge(id("e1"), id("entry"), id("left"), "started"),
          buildEdge(id("e2"), id("entry"), id("right"), "canceled"),
          buildEdge(id("e3"), id("left"), id("last")),
          // A second edge into the last node sends the graph down the fallback.
          ...(join ? [buildEdge(id("e4"), id("right"), id("last"))] : []),
        ],
      };
    };

    for (const join of [false, true]) {
      const first = await layoutWorkflowNodes(buildGraph("-aaa", join));
      const second = await layoutWorkflowNodes(buildGraph("-zzz", join));

      expect(second.nodes.map((node) => node.position)).toEqual(
        first.nodes.map((node) => node.position)
      );
    }
  });

  test("keeps add nodes untouched while reflowing workflow nodes", async () => {
    const addNode = buildNode("add-placeholder", { x: 999, y: 999 }, "add");
    const nodes = [
      buildNode("lifecycle", { x: 0, y: 0 }, "lifecycle"),
      buildNode("action", { x: 420, y: 210 }),
      addNode,
    ];
    const edges = [buildEdge("e1", "lifecycle", "action")];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });
    const nextAddNode = result.nodes.find((node) => node.id === addNode.id);

    expect(nextAddNode?.position).toEqual(addNode.position);
    expect(nextAddNode?.type).toBe("add");
  });

  test("holds the Canceled column open when only Started is wired", async () => {
    const nodes = [
      buildNode("entry", { x: 0, y: 0 }, "lifecycle"),
      buildNode("started", { x: 400, y: 300 }),
    ];
    const edges = [buildEdge("e1", "entry", "started", "started")];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    // The branch sits in the Started column with Canceled held open beside it,
    // so wiring Canceled later moves nothing that is already placed.
    expect(
      positionX(result.nodes, "entry") - positionX(result.nodes, "started")
    ).toBe(HALF_SIBLING_PITCH);
  });

  test("reads the entry node off the type its wire schema requires", async () => {
    // React Flow's own top-level `type` is optional on a saved node, so a graph
    // that decodes without one must still be read as an entry node through
    // `data.type` and hold its Canceled column.
    const { type: _type, ...entry } = buildNode(
      "entry",
      { x: 0, y: 0 },
      "lifecycle"
    );
    const nodes = [entry, buildNode("started", { x: 400, y: 300 })];
    const edges = [buildEdge("e1", "entry", "started", "started")];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    expect(
      positionX(result.nodes, "entry") - positionX(result.nodes, "started")
    ).toBe(HALF_SIBLING_PITCH);
  });

  test("wiring the second branch moves nothing already placed", async () => {
    const started = buildNode("started", { x: 400, y: 300 });
    const wiredEdge = buildEdge("e1", "entry", "started", "started");
    const oneBranch = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes: [buildNode("entry", { x: 0, y: 0 }, "lifecycle"), started],
      edges: [wiredEdge],
    });

    const bothBranches = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes: [...oneBranch.nodes, buildNode("canceled", { x: 900, y: 300 })],
      edges: [wiredEdge, buildEdge("e2", "entry", "canceled", "canceled")],
    });

    // The Canceled branch lands in the column that was held for it, so the
    // entry node and the Started branch both keep the x they had.
    for (const id of ["entry", "started"]) {
      expect(positionX(bothBranches.nodes, id)).toBe(
        positionX(oneBranch.nodes, id)
      );
    }
    expect(positionX(bothBranches.nodes, "canceled")).toBeGreaterThan(
      positionX(bothBranches.nodes, "entry")
    );
  });

  test("holds the False column open when only True is wired", async () => {
    const nodes = [
      buildNode("entry", { x: 0, y: 0 }, "lifecycle"),
      buildConditionNode("condition", { x: 0, y: 300 }),
      buildNode("then", { x: 0, y: 600 }),
    ];
    const edges = [
      buildEdge("e1", "entry", "condition", "started"),
      buildEdge("e2", "condition", "then", "true"),
    ];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    expect(
      positionX(result.nodes, "condition") - positionX(result.nodes, "then")
    ).toBe(HALF_SIBLING_PITCH);
  });

  test("holds no column open for an Event Split outlet", async () => {
    // The card already grows a slot per Event, so its outlets need no column of
    // their own and the one wired branch stays under the card.
    const nodes = [
      buildEntryNode("entry", { x: 0, y: 0 }, [
        CREATED_EVENT,
        RESCHEDULED_EVENT,
      ]),
      buildEventSplitNode("split", { x: 0, y: 300 }),
      buildNode("created", { x: 0, y: 600 }),
    ];
    const edges = [
      buildEdge("e1", "entry", "split", "started"),
      buildEdge("e2", "split", "created", eventSplitOutlet(CREATED_EVENT)),
    ];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    expect(centerX(result.nodes, "split", eventSplitCardWidth(2))).toBe(
      centerX(result.nodes, "created", WORKFLOW_NODE_WIDTH)
    );
  });

  test("holds no column open when no edge names an outlet", async () => {
    const nodes = [
      buildNode("entry", { x: 0, y: 0 }, "lifecycle"),
      buildNode("next", { x: 400, y: 300 }),
    ];
    const edges = [buildEdge("e1", "entry", "next")];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    expect(positionX(result.nodes, "entry")).toBe(
      positionX(result.nodes, "next")
    );
  });

  test("keeps an entry node with nothing wired where it is", async () => {
    const nodes = [buildNode("entry", { x: 40, y: 40 }, "lifecycle")];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges: [],
    });

    expect(result.changed).toBe(false);
    expect(result.nodes[0]?.position).toEqual({ x: 40, y: 40 });
  });

  test("lays out a chain holding a Group as a tree", async () => {
    const frame = groupFrameSize(1, 2);
    const graph = buildFramedChain({
      entryIds: ["lookup"],
      members: ["lookup", "exit"],
      interior: [buildEdge("i1", "lookup", "exit")],
    });

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      ...graph,
    });

    // A frame takes the tree path now, so the chain reads as one centre line,
    // with the column held for Canceled off to the right of the entry node.
    const waitCenter = centerX(result.nodes, "wait", WORKFLOW_NODE_WIDTH);
    expect(centerX(result.nodes, "g", frame.width)).toBe(waitCenter);
    expect(centerX(result.nodes, "sms", WORKFLOW_NODE_WIDTH)).toBe(waitCenter);
    expect(centerX(result.nodes, "entry", WORKFLOW_NODE_WIDTH)).toBe(
      waitCenter + HALF_SIBLING_PITCH
    );
  });

  test("gives a Group a rank as tall as the frame draws", async () => {
    const frame = groupFrameSize(1, 2);
    const graph = buildFramedChain({
      entryIds: ["lookup"],
      members: ["lookup", "exit"],
      interior: [buildEdge("i1", "lookup", "exit")],
    });

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      ...graph,
    });

    // The step after the frame clears the whole box, so the frame's own height
    // is what sets the gap rather than the height of a standard card.
    expect(positionY(result.nodes, "g")).toBe(
      positionY(result.nodes, "wait") + WORKFLOW_NODE_HEIGHT + RANK_SPACING
    );
    expect(positionY(result.nodes, "sms")).toBe(
      positionY(result.nodes, "g") + frame.height + RANK_SPACING
    );
  });

  test("lays out a chain holding a parallel-lookup Group", async () => {
    // Two entries fanning in on one exit: the painted inlet edges collapse to
    // one, so the frame keeps an in-degree of one and stays on the tree path.
    const frame = groupFrameSize(2, 2);
    const graph = buildFramedChain({
      entryIds: ["one", "two"],
      members: ["one", "two", "exit"],
      interior: [
        buildEdge("i1", "one", "exit"),
        buildEdge("i2", "two", "exit"),
      ],
    });

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      ...graph,
    });

    const waitCenter = centerX(result.nodes, "wait", WORKFLOW_NODE_WIDTH);
    expect(centerX(result.nodes, "g", frame.width)).toBe(waitCenter);
    expect(positionY(result.nodes, "sms")).toBe(
      positionY(result.nodes, "g") + frame.height + RANK_SPACING
    );
  });

  test("holds no column open on the dagre path", async () => {
    // The join sends this graph to the fallback, where dagre's ordering pass
    // reorders a rank freely and a spare node lands on either side of the
    // branch it was meant to sit beside. The fallback therefore keeps the lone
    // branch under the card that feeds it.
    const nodes = [
      buildNode("entry", { x: 0, y: 0 }, "lifecycle"),
      buildNode("started", { x: 0, y: 300 }),
      buildNode("other", { x: 400, y: 300 }),
      buildNode("join", { x: 200, y: 600 }),
    ];
    const edges = [
      buildEdge("e1", "entry", "started", "started"),
      buildEdge("e2", "started", "join"),
      buildEdge("e3", "other", "join"),
    ];

    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes,
      edges,
    });

    expect(positionX(result.nodes, "entry")).toBe(
      positionX(result.nodes, "started")
    );
  });

  test("lays out a Group as one box and keeps children relative", async () => {
    const group: WorkflowNode = {
      id: "g",
      type: "group",
      position: { x: 0, y: 200 },
      data: {
        label: "Lookups",
        type: "group",
        config: { entryNodeIds: ["a"], exitNodeId: "c" },
      },
    };
    const childA: WorkflowNode = {
      ...buildNode("a", { x: 12, y: 48 }),
      parentId: "g",
      extent: "parent",
    };
    const childC: WorkflowNode = {
      ...buildNode("c", { x: 12, y: 112 }),
      parentId: "g",
      extent: "parent",
    };
    const result = await layoutWorkflowNodes({
      catalog: layoutCatalog,
      nodes: [
        buildNode("lifecycle", { x: 0, y: 0 }, "lifecycle"),
        group,
        childA,
        childC,
        buildNode("sms", { x: 0, y: 500 }),
      ],
      edges: [
        buildEdge("e1", "lifecycle", "a"),
        buildEdge("e2", "a", "c"),
        buildEdge("e3", "c", "sms"),
      ],
    });

    const nextGroup = result.nodes.find((node) => node.id === "g");
    const nextA = result.nodes.find((node) => node.id === "a");
    const nextSms = result.nodes.find((node) => node.id === "sms");

    expect(nextGroup?.parentId).toBeUndefined();
    expect(nextA?.parentId).toBe("g");
    expect(nextA?.position.x).toBeGreaterThanOrEqual(0);
    expect(nextSms?.position.y).toBeGreaterThan(nextGroup?.position.y ?? 0);
  });
});
