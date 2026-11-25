import { describe, expect, it } from "vitest";
import {
  normalizeSourceHandleForConnection,
  soleStartedPathEnd,
} from "#src/components/workflow/connection-handle";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";

const emptyCatalog = emptyExtensionCatalog;

function lifecycleNode(id = "entry"): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "", type: "lifecycle", config: {} },
  };
}

function conditionNode(id = "cond"): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "",
      type: "action",
      config: { actionType: "Condition" },
    },
  };
}

function plainActionNode(id = "action"): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: "", type: "action", config: {} },
  };
}

describe("normalizeSourceHandleForConnection", () => {
  // An edge dragged off the entry node has to keep the handle it was actually
  // dragged from; relabeling every edge to Started would make the Canceled
  // outlet undraggable.
  it("keeps the Canceled handle when that is what was dragged", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes: [lifecycleNode()],
        edges: [],
        sourceNodeId: "entry",
        sourceHandle: LIFECYCLE_CANCELED_HANDLE,
        catalog: emptyCatalog,
      })
    ).toBe(LIFECYCLE_CANCELED_HANDLE);
  });

  it("keeps the Started handle when that is what was dragged", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes: [lifecycleNode()],
        edges: [],
        sourceNodeId: "entry",
        sourceHandle: LIFECYCLE_STARTED_HANDLE,
        catalog: emptyCatalog,
      })
    ).toBe(LIFECYCLE_STARTED_HANDLE);
  });

  it("falls back to Started for a connection made with no handle to read", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes: [lifecycleNode()],
        edges: [],
        sourceNodeId: "entry",
        sourceHandle: null,
        catalog: emptyCatalog,
      })
    ).toBe(LIFECYCLE_STARTED_HANDLE);
  });

  it("takes the True branch when a Condition node's outgoing edge is unlabeled", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes: [conditionNode()],
        edges: [],
        sourceNodeId: "cond",
        sourceHandle: null,
        catalog: emptyCatalog,
      })
    ).toBe("true");
  });

  it("takes the False branch once True is already taken", () => {
    const edges: WorkflowEdge[] = [
      {
        id: "e1",
        source: "cond",
        target: "other",
        sourceHandle: "true",
      },
    ];

    expect(
      normalizeSourceHandleForConnection({
        nodes: [conditionNode()],
        edges,
        sourceNodeId: "cond",
        sourceHandle: null,
        catalog: emptyCatalog,
      })
    ).toBe("false");
  });

  it("passes an ordinary action node's handle through unchanged", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes: [plainActionNode()],
        edges: [],
        sourceNodeId: "action",
        sourceHandle: "out",
        catalog: emptyCatalog,
      })
    ).toBe("out");
  });
});

describe("normalizeSourceHandleForConnection - Event Split", () => {
  const CREATED = "app/appointment.created";
  const RESCHEDULED = "app/appointment.rescheduled";

  const eventSplitCatalog: ExtensionCatalog = {
    entities: [],
    events: [
      { name: CREATED, label: CREATED, payloadFields: [] },
      { name: RESCHEDULED, label: RESCHEDULED, payloadFields: [] },
    ],
    actions: [],
    integrations: [],
  };

  function splitNode(id = "split"): WorkflowNode {
    return {
      id,
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "",
        type: "action",
        config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
      },
    };
  }

  function entryNode(startEvents: string[]): WorkflowNode {
    return {
      id: "entry",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        label: "",
        type: "lifecycle",
        config: {
          lifecycleRules: {
            startEvents,
            cancelEvents: [],
            concurrency: "unlimited",
          },
        },
      },
    };
  }

  const nodes = [entryNode([CREATED, RESCHEDULED]), splitNode()];
  const entryEdge: WorkflowEdge = {
    id: "e1",
    source: "entry",
    sourceHandle: LIFECYCLE_STARTED_HANDLE,
    target: "split",
  };

  it("keeps the outlet an edge was actually dragged from", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes,
        edges: [entryEdge],
        sourceNodeId: "split",
        sourceHandle: eventSplitOutlet(RESCHEDULED),
        catalog: eventSplitCatalog,
      })
    ).toBe(eventSplitOutlet(RESCHEDULED));
  });

  // The gesture this exists for: the drag started at the downstream node's own
  // input handle, so the canvas has no source handle to pass on.
  it("takes the first free outlet for a connection carrying no handle", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes,
        edges: [entryEdge],
        sourceNodeId: "split",
        sourceHandle: null,
        catalog: eventSplitCatalog,
      })
    ).toBe(eventSplitOutlet(CREATED));
  });

  it("takes the next outlet once the first is connected", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes,
        edges: [
          entryEdge,
          {
            id: "e2",
            source: "split",
            sourceHandle: eventSplitOutlet(CREATED),
            target: "downstream",
          },
        ],
        sourceNodeId: "split",
        sourceHandle: null,
        catalog: eventSplitCatalog,
      })
    ).toBe(eventSplitOutlet(RESCHEDULED));
  });

  it("answers nothing where no Event reaches the split", () => {
    // Nothing connects the split to the entry node, so it has no outlets to
    // choose between and the save refuses the edge rather than inventing one.
    expect(
      normalizeSourceHandleForConnection({
        nodes,
        edges: [],
        sourceNodeId: "split",
        sourceHandle: null,
        catalog: eventSplitCatalog,
      })
    ).toBeNull();
  });
});

describe("group outlet handle", () => {
  const group: WorkflowNode = {
    id: "g",
    type: "group",
    position: { x: 0, y: 0 },
    data: { label: "Group", type: "group" },
  };
  const lookup: WorkflowNode = {
    id: "a",
    parentId: "g",
    position: { x: 0, y: 0 },
    data: {
      label: "Lookup",
      type: "action",
      config: { actionType: "fountain/get-user" },
    },
  };
  const condition: WorkflowNode = {
    id: "c",
    parentId: "g",
    position: { x: 0, y: 0 },
    data: {
      label: "Condition",
      type: "action",
      config: { actionType: BUILT_IN_ACTION_IDS.condition },
    },
  };

  it("names no handle for a drag from a Group card, which has one outlet", () => {
    const nodes = [group, lookup, condition];
    const edges = [{ id: "ac", source: "a", target: "c" }];

    expect(
      normalizeSourceHandleForConnection({
        nodes,
        edges,
        sourceNodeId: "g",
        sourceHandle: "false",
        catalog: emptyCatalog,
      })
    ).toBeNull();
  });

  it("names no handle for a connection from a Group that names none", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes: [group, lookup, { ...lookup, id: "b" }],
        edges: [{ id: "ab", source: "a", target: "b" }],
        sourceNodeId: "g",
        sourceHandle: null,
        catalog: emptyCatalog,
      })
    ).toBeNull();
  });
});

describe("soleStartedPathEnd", () => {
  function edge(
    source: string,
    target: string,
    sourceHandle: string | null = null
  ): WorkflowEdge {
    return { id: `${source}-${target}`, source, target, sourceHandle };
  }

  it("answers the Started outlet of a new workflow", () => {
    expect(
      soleStartedPathEnd({
        nodes: [lifecycleNode()],
        edges: [],
        catalog: emptyCatalog,
      })
    ).toEqual({ nodeId: "entry", handle: LIFECYCLE_STARTED_HANDLE });
  });

  it("answers the last step of a straight path, ignoring Canceled", () => {
    expect(
      soleStartedPathEnd({
        nodes: [lifecycleNode(), plainActionNode("a"), plainActionNode("b")],
        edges: [edge("entry", "a", LIFECYCLE_STARTED_HANDLE), edge("a", "b")],
        catalog: emptyCatalog,
      })
    ).toEqual({ nodeId: "b", handle: null });
  });

  it("answers nothing when a Condition leaves two branches open", () => {
    expect(
      soleStartedPathEnd({
        nodes: [lifecycleNode(), conditionNode()],
        edges: [edge("entry", "cond", LIFECYCLE_STARTED_HANDLE)],
        catalog: emptyCatalog,
      })
    ).toBeNull();
  });

  // The True branch ends at "b", which leaves "b" and the False branch open.
  it("answers nothing when a branch and a step are both open", () => {
    expect(
      soleStartedPathEnd({
        nodes: [
          lifecycleNode(),
          conditionNode(),
          plainActionNode("a"),
          plainActionNode("b"),
        ],
        edges: [
          edge("entry", "cond", LIFECYCLE_STARTED_HANDLE),
          edge("cond", "a", "true"),
          edge("a", "b"),
        ],
        catalog: emptyCatalog,
      })
    ).toBeNull();
  });

  // A disabled step ends the True branch, which leaves False the one open end.
  it("answers a Condition's one open branch", () => {
    const disabled = plainActionNode("off");
    disabled.data.enabled = false;
    expect(
      soleStartedPathEnd({
        nodes: [lifecycleNode(), conditionNode(), disabled],
        edges: [
          edge("entry", "cond", LIFECYCLE_STARTED_HANDLE),
          edge("cond", "off", "true"),
        ],
        catalog: emptyCatalog,
      })
    ).toEqual({ nodeId: "cond", handle: "false" });
  });

  it("stops at a disabled step, which ends its branch on purpose", () => {
    const disabled = plainActionNode("off");
    disabled.data.enabled = false;
    expect(
      soleStartedPathEnd({
        nodes: [lifecycleNode(), plainActionNode("a"), disabled],
        edges: [edge("entry", "a", LIFECYCLE_STARTED_HANDLE), edge("a", "off")],
        catalog: emptyCatalog,
      })
    ).toBeNull();
  });

  it("answers nothing when the one open end is inside a Group", () => {
    const member = { ...plainActionNode("a"), parentId: "group" };
    expect(
      soleStartedPathEnd({
        nodes: [lifecycleNode(), member],
        edges: [edge("entry", "a", LIFECYCLE_STARTED_HANDLE)],
        catalog: emptyCatalog,
      })
    ).toBeNull();
  });
});
