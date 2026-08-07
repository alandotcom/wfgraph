import { describe, expect, test, vi } from "vitest";
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "#src/lib/workflow-graph-types";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import { layoutWorkflowNodes } from "./workflow-layout";
import {
  eventSplitCardWidth,
  WORKFLOW_NODE_WIDTH,
} from "./workflow-node-dimensions";

/**
 * An Event Split's outlets are the Events reaching it, which the layout reads
 * through the catalog. These are the two an `EVENT_SPLIT_EVENTS` graph declares.
 */
const CREATED_EVENT = "app/appointment.created";
const RESCHEDULED_EVENT = "app/appointment.rescheduled";
const CONFIRMED_EVENT = "app/appointment.confirmed";

// The names are spelled out again below because vitest lifts this call above
// the constants, which would still be in their dead zone when it runs.
vi.mock("#src/lib/extensions", () => ({
  getExtensionCatalog: () => ({
    integrations: [],
    actions: [],
    events: [
      {
        name: "app/appointment.created",
        label: "Appointment created",
        payloadFields: [],
      },
      {
        name: "app/appointment.rescheduled",
        label: "Appointment rescheduled",
        payloadFields: [],
      },
      {
        name: "app/appointment.confirmed",
        label: "Appointment confirmed",
        payloadFields: [],
      },
    ],
  }),
}));

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

function positionX(nodes: WorkflowNode[], id: string): number {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) {
    throw new Error(`no node ${id} in the layout result`);
  }

  return node.position.x;
}

describe("layoutWorkflowNodes", () => {
  test("returns unchanged result when no nodes exist", async () => {
    const result = await layoutWorkflowNodes({ nodes: [], edges: [] });
    expect(result.changed).toBe(false);
    expect(result.nodes).toEqual([]);
  });

  test("keeps canonical single-node position unchanged", async () => {
    const nodes = [buildNode("a", { x: 40, y: 40 })];
    const result = await layoutWorkflowNodes({ nodes, edges: [] });
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

    const first = await layoutWorkflowNodes({ nodes, edges });
    const second = await layoutWorkflowNodes({
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

    const result = await layoutWorkflowNodes({ nodes, edges });

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

    const result = await layoutWorkflowNodes({ nodes, edges });

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

    const result = await layoutWorkflowNodes({ nodes, edges });

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

    const result = await layoutWorkflowNodes({ nodes, edges });
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

    const result = await layoutWorkflowNodes({ nodes, edges });

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

    const result = await layoutWorkflowNodes({ nodes, edges });

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

    const result = await layoutWorkflowNodes({ nodes, edges });

    expect(positionX(result.nodes, "z-left")).toBeLessThan(
      positionX(result.nodes, "a-right")
    );
  });

  test("orders two branches sitting at one place by how they were wired", async () => {
    const buildGraph = (firstTarget: string, secondTarget: string) => ({
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

    const result = await layoutWorkflowNodes({ nodes, edges });

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

    const result = await layoutWorkflowNodes({ nodes, edges });

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

    const result = await layoutWorkflowNodes({ nodes, edges });
    const nextAddNode = result.nodes.find((node) => node.id === addNode.id);

    expect(nextAddNode?.position).toEqual(addNode.position);
    expect(nextAddNode?.type).toBe("add");
  });
});
