import { describe, expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import {
  type ConditionModel,
  type ConditionRule,
  compileConditionModel,
  EVENT_NAME_FIELD_PATH,
  serializeConditionModel,
} from "#src/conditions/conditions";
import type {
  ActionMetadata,
  EventMetadata,
  ExtensionCatalog,
} from "#src/extensions/catalog";
import { eventsReaching } from "#src/graph/events-reaching";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { eventSplitOutlet } from "#src/lifecycle/event-split";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "#src/lifecycle/lifecycle-outlets";

const CREATED = "app/appointment.created";
const CANCELED = "app/appointment.canceled";
const RESCHEDULED = "app/appointment.rescheduled";

function anEvent(name: string, paths: string[]): EventMetadata {
  return {
    name,
    label: name,
    payloadFields: paths.map((path) => ({ path, type: "string" as const })),
  };
}

function anAction(id: string, paths: string[]): ActionMetadata {
  return {
    id,
    label: id,
    description: "",
    category: "Custom",
    configFields: [],
    outputFields: paths.map((path) => ({ path, type: "string" as const })),
  };
}

const catalog: ExtensionCatalog = {
  events: [
    anEvent(CREATED, ["appointmentId", "bookedBy"]),
    anEvent(CANCELED, ["appointmentId", "reason"]),
    anEvent(RESCHEDULED, ["appointmentId", "movedBy"]),
  ],
  actions: [anAction("custom/lookup", ["reason"])],
  integrations: [],
};

function entryNode(input: {
  startEvents?: string[];
  cancelEvents?: string[];
}): WorkflowNode {
  return {
    id: "lifecycle-1",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: input.startEvents ?? [],
          cancelEvents: input.cancelEvents ?? [],
          concurrency: "unlimited",
        },
      },
    },
  };
}

function actionNode(id: string, actionType = "custom/notify"): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action", config: { actionType } },
  };
}

function waitNode(
  id: string,
  waitFor: string[],
  waitMode: "delay" | "event" = "event"
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: {
        actionType: BUILT_IN_ACTION_IDS.wait,
        waitMode,
        ...(waitMode === "event"
          ? { waitFor: waitFor.map((event) => ({ event })) }
          : {}),
      },
    },
  };
}

/** A Condition node carrying the model these rules make, ANDed in one group. */
function conditionNode(id: string, conditions: ConditionRule[]): WorkflowNode {
  const model: ConditionModel = {
    version: 2,
    groupLogic: "and",
    groups: [{ id: "group-1", logic: "and", conditions }],
  };

  const compiled = compileConditionModel(model);

  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: {
        actionType: "Condition",
        ...(compiled.valid ? { condition: compiled.expression } : {}),
        conditionModel: serializeConditionModel(model),
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
  return { id, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

function eventNameRule(
  operator: "equals" | "not_equals",
  value: string
): ConditionRule {
  return {
    id: "rule-event",
    field: EVENT_NAME_FIELD_PATH,
    fieldType: "string",
    operator,
    value,
  };
}

function fieldRule(path: string): ConditionRule {
  return {
    id: "rule-field",
    field: path,
    fieldType: "string",
    operator: "equals",
    value: "x",
  };
}

/** The Event names reaching `targetNodeId`, which is what every case asserts. */
function namesReaching(
  targetNodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): string[] {
  return eventsReaching({ targetNodeId, nodes, edges, catalog }).map(
    (event) => event.name
  );
}

describe("eventsReaching", () => {
  it("gives a node behind Started every Start Event", () => {
    const nodes = [
      entryNode({ startEvents: [CREATED, RESCHEDULED] }),
      actionNode("action-1"),
    ];

    expect(
      namesReaching("action-1", nodes, [
        edge("e1", "lifecycle-1", "action-1", LIFECYCLE_STARTED_HANDLE),
      ])
    ).toEqual([CREATED, RESCHEDULED]);
  });

  it("gives a node behind Canceled every Cancel Event", () => {
    const nodes = [
      entryNode({
        startEvents: [CREATED],
        cancelEvents: [CANCELED, RESCHEDULED],
      }),
      actionNode("action-1"),
    ];

    expect(
      namesReaching("action-1", nodes, [
        edge("e1", "lifecycle-1", "action-1", LIFECYCLE_CANCELED_HANDLE),
      ])
    ).toEqual([CANCELED, RESCHEDULED]);
  });

  it("carries the set through a node that decides nothing", () => {
    const nodes = [
      entryNode({ cancelEvents: [CANCELED, RESCHEDULED] }),
      actionNode("action-1"),
      actionNode("action-2"),
    ];

    expect(
      namesReaching("action-2", nodes, [
        edge("e1", "lifecycle-1", "action-1", LIFECYCLE_CANCELED_HANDLE),
        edge("e2", "action-1", "action-2"),
      ])
    ).toEqual([CANCELED, RESCHEDULED]);
  });

  // The case that prompted this: a Condition splitting the Cancel Events into
  // one branch each.
  it("splits the Events between a Condition's two lines", () => {
    const nodes = [
      entryNode({ cancelEvents: [CANCELED, RESCHEDULED] }),
      conditionNode("which-1", [eventNameRule("equals", CANCELED)]),
      actionNode("on-true"),
      actionNode("on-false"),
    ];
    const edges = [
      edge("e1", "lifecycle-1", "which-1", LIFECYCLE_CANCELED_HANDLE),
      edge("e2", "which-1", "on-true", "true"),
      edge("e3", "which-1", "on-false", "false"),
    ];

    expect(namesReaching("on-true", nodes, edges)).toEqual([CANCELED]);
    expect(namesReaching("on-false", nodes, edges)).toEqual([RESCHEDULED]);
  });

  it("leaves one Event behind each Event Split outlet", () => {
    const nodes = [
      entryNode({ startEvents: [CREATED, RESCHEDULED] }),
      actionNode("split-1", BUILT_IN_ACTION_IDS.eventSplit),
      actionNode("on-created"),
      actionNode("on-rescheduled"),
    ];
    const edges = [
      edge("e1", "lifecycle-1", "split-1", LIFECYCLE_STARTED_HANDLE),
      edge("e2", "split-1", "on-created", eventSplitOutlet(CREATED)),
      edge("e3", "split-1", "on-rescheduled", eventSplitOutlet(RESCHEDULED)),
    ];

    expect(namesReaching("on-created", nodes, edges)).toEqual([CREATED]);
    expect(namesReaching("on-rescheduled", nodes, edges)).toEqual([
      RESCHEDULED,
    ]);
  });

  it("leaves nothing behind an Event Split outlet no run can take", () => {
    // An outlet for an Event that cannot reach the split is a branch no run
    // travels, so there is no payload to promise a node behind it.
    const nodes = [
      entryNode({ startEvents: [CREATED] }),
      actionNode("split-1", BUILT_IN_ACTION_IDS.eventSplit),
      actionNode("on-canceled"),
    ];
    const edges = [
      edge("e1", "lifecycle-1", "split-1", LIFECYCLE_STARTED_HANDLE),
      edge("e2", "split-1", "on-canceled", eventSplitOutlet(CANCELED)),
    ];

    expect(namesReaching("on-canceled", nodes, edges)).toEqual([]);
  });

  it("gives the Event Split itself every Event that reaches it", () => {
    // What the node's own outlets are derived from, so the panel and the canvas
    // ask this rather than reading the Lifecycle Rules a second time.
    const nodes = [
      entryNode({ startEvents: [CREATED, RESCHEDULED] }),
      actionNode("split-1", BUILT_IN_ACTION_IDS.eventSplit),
    ];
    const edges = [
      edge("e1", "lifecycle-1", "split-1", LIFECYCLE_STARTED_HANDLE),
    ];

    expect(namesReaching("split-1", nodes, edges)).toEqual([
      CREATED,
      RESCHEDULED,
    ]);
  });

  it("keeps the Start Events at an event-mode Wait, and hands its subscriptions on", () => {
    // The Wait is where those Events arrive, so a node sitting on it still sees
    // whatever put the run there. Everything below sees the Events it parks on,
    // which is how an Event Split after a Wait has something new to split.
    const nodes = [
      entryNode({ startEvents: [CREATED] }),
      waitNode("wait-1", [CANCELED, RESCHEDULED]),
      actionNode("after-wait"),
    ];
    const edges = [
      edge("e1", "lifecycle-1", "wait-1", LIFECYCLE_STARTED_HANDLE),
      edge("e2", "wait-1", "after-wait"),
    ];

    expect(namesReaching("wait-1", nodes, edges)).toEqual([CREATED]);
    expect(namesReaching("after-wait", nodes, edges)).toEqual([
      CANCELED,
      RESCHEDULED,
    ]);
  });

  it("leaves one Event behind each Event Split outlet below a Wait", () => {
    const nodes = [
      entryNode({ startEvents: [CREATED] }),
      waitNode("wait-1", [CANCELED, RESCHEDULED]),
      actionNode("split-1", BUILT_IN_ACTION_IDS.eventSplit),
      actionNode("on-canceled"),
      actionNode("on-rescheduled"),
    ];
    const edges = [
      edge("e1", "lifecycle-1", "wait-1", LIFECYCLE_STARTED_HANDLE),
      edge("e2", "wait-1", "split-1"),
      edge("e3", "split-1", "on-canceled", eventSplitOutlet(CANCELED)),
      edge("e4", "split-1", "on-rescheduled", eventSplitOutlet(RESCHEDULED)),
    ];

    expect(namesReaching("split-1", nodes, edges)).toEqual([
      CANCELED,
      RESCHEDULED,
    ]);
    expect(namesReaching("on-canceled", nodes, edges)).toEqual([CANCELED]);
    expect(namesReaching("on-rescheduled", nodes, edges)).toEqual([
      RESCHEDULED,
    ]);
  });

  it("leaves a Start Event outlet empty when the Wait replaced the set", () => {
    // The Start Event put the run at the Wait; it is not what wakes it. An
    // Event Split below the Wait offering that Event would be a branch no
    // resume travels.
    const nodes = [
      entryNode({ startEvents: [CREATED] }),
      waitNode("wait-1", [CANCELED]),
      actionNode("split-1", BUILT_IN_ACTION_IDS.eventSplit),
      actionNode("on-created"),
    ];
    const edges = [
      edge("e1", "lifecycle-1", "wait-1", LIFECYCLE_STARTED_HANDLE),
      edge("e2", "wait-1", "split-1"),
      edge("e3", "split-1", "on-created", eventSplitOutlet(CREATED)),
    ];

    expect(namesReaching("on-created", nodes, edges)).toEqual([]);
  });

  it("carries the Start Events through a Wait that parks on a clock", () => {
    const nodes = [
      entryNode({ startEvents: [CREATED, RESCHEDULED] }),
      waitNode("wait-1", [], "delay"),
      actionNode("after-wait"),
    ];
    const edges = [
      edge("e1", "lifecycle-1", "wait-1", LIFECYCLE_STARTED_HANDLE),
      edge("e2", "wait-1", "after-wait"),
    ];

    expect(namesReaching("after-wait", nodes, edges)).toEqual([
      CREATED,
      RESCHEDULED,
    ]);
  });

  it("inverts both lines for a not_equals rule", () => {
    const nodes = [
      entryNode({ cancelEvents: [CANCELED, RESCHEDULED] }),
      conditionNode("which-1", [eventNameRule("not_equals", CANCELED)]),
      actionNode("on-true"),
      actionNode("on-false"),
    ];
    const edges = [
      edge("e1", "lifecycle-1", "which-1", LIFECYCLE_CANCELED_HANDLE),
      edge("e2", "which-1", "on-true", "true"),
      edge("e3", "which-1", "on-false", "false"),
    ];

    expect(namesReaching("on-true", nodes, edges)).toEqual([RESCHEDULED]);
    expect(namesReaching("on-false", nodes, edges)).toEqual([CANCELED]);
  });

  // A rule about a field the payload lacks reads false, so testing a field only
  // one Event declares says which Event arrived without naming it.
  it("narrows on a field only one Event declares", () => {
    const nodes = [
      entryNode({ cancelEvents: [CANCELED, RESCHEDULED] }),
      conditionNode("which-1", [fieldRule("movedBy")]),
      actionNode("on-true"),
    ];

    expect(
      namesReaching("on-true", nodes, [
        edge("e1", "lifecycle-1", "which-1", LIFECYCLE_CANCELED_HANDLE),
        edge("e2", "which-1", "on-true", "true"),
      ])
    ).toEqual([RESCHEDULED]);
  });

  // The condition context is a flat merge of every upstream output, so a path an
  // upstream action also declares may be that action's rather than the payload's.
  it("narrows nothing on a path an upstream action also declares", () => {
    const nodes = [
      entryNode({ cancelEvents: [CANCELED, RESCHEDULED] }),
      actionNode("lookup-1", "custom/lookup"),
      conditionNode("which-1", [fieldRule("reason")]),
      actionNode("on-true"),
    ];

    expect(
      namesReaching("on-true", nodes, [
        edge("e1", "lifecycle-1", "lookup-1", LIFECYCLE_CANCELED_HANDLE),
        edge("e2", "lookup-1", "which-1"),
        edge("e3", "which-1", "on-true", "true"),
      ])
    ).toEqual([CANCELED, RESCHEDULED]);
  });

  it("keeps every Event either arm of an OR group admits", () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "or",
          conditions: [
            eventNameRule("equals", CANCELED),
            { ...eventNameRule("equals", RESCHEDULED), id: "rule-event-2" },
          ],
        },
      ],
    };

    const which: WorkflowNode = {
      id: "which-1",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "which-1",
        type: "action",
        config: {
          actionType: "Condition",
          conditionModel: serializeConditionModel(model),
        },
      },
    };

    const nodes = [
      entryNode({ cancelEvents: [CANCELED, RESCHEDULED] }),
      which,
      actionNode("on-true"),
    ];

    expect(
      namesReaching("on-true", nodes, [
        edge("e1", "lifecycle-1", "which-1", LIFECYCLE_CANCELED_HANDLE),
        edge("e2", "which-1", "on-true", "true"),
      ])
    ).toEqual([CANCELED, RESCHEDULED]);
  });

  // Offering a field too many is noise; hiding one is a bug the builder cannot
  // see. So anything the analysis cannot read narrows nothing.
  it("narrows nothing when the model does not parse", () => {
    const which: WorkflowNode = {
      id: "which-1",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "which-1",
        type: "action",
        config: { actionType: "Condition", conditionModel: "{oops" },
      },
    };

    const nodes = [
      entryNode({ cancelEvents: [CANCELED, RESCHEDULED] }),
      which,
      actionNode("on-true"),
    ];

    expect(
      namesReaching("on-true", nodes, [
        edge("e1", "lifecycle-1", "which-1", LIFECYCLE_CANCELED_HANDLE),
        edge("e2", "which-1", "on-true", "true"),
      ])
    ).toEqual([CANCELED, RESCHEDULED]);
  });

  it("offers nothing to a node no outlet reaches", () => {
    const nodes = [entryNode({ startEvents: [CREATED] }), actionNode("orphan")];

    expect(namesReaching("orphan", nodes, [])).toEqual([]);
  });

  it("intersects Events across AND-join arms", () => {
    const nodes = [
      entryNode({ startEvents: [CREATED, RESCHEDULED] }),
      actionNode("left"),
      actionNode("right"),
      actionNode("join"),
    ];

    expect(
      namesReaching("join", nodes, [
        edge("e1", "lifecycle-1", "left", LIFECYCLE_STARTED_HANDLE),
        edge("e2", "lifecycle-1", "right", LIFECYCLE_STARTED_HANDLE),
        edge("e3", "left", "join"),
        edge("e4", "right", "join"),
      ])
    ).toEqual([CREATED, RESCHEDULED]);
  });

  it("offers nothing at an AND-join of Started and Canceled", () => {
    const nodes = [
      entryNode({
        startEvents: [CREATED],
        cancelEvents: [CANCELED],
      }),
      actionNode("started-arm"),
      actionNode("canceled-arm"),
      actionNode("join"),
    ];

    expect(
      namesReaching("join", nodes, [
        edge("e1", "lifecycle-1", "started-arm", LIFECYCLE_STARTED_HANDLE),
        edge("e2", "lifecycle-1", "canceled-arm", LIFECYCLE_CANCELED_HANDLE),
        edge("e3", "started-arm", "join"),
        edge("e4", "canceled-arm", "join"),
      ])
    ).toEqual([]);
  });

  it("offers nothing through an entry edge naming no outlet", () => {
    const nodes = [
      entryNode({ startEvents: [CREATED] }),
      actionNode("action-1"),
    ];

    expect(
      namesReaching("action-1", nodes, [edge("e1", "lifecycle-1", "action-1")])
    ).toEqual([]);
  });

  // Saving refuses a cycle, and this runs against whatever the canvas holds.
  it("terminates on a cycle rather than walking it", () => {
    const nodes = [actionNode("action-1"), actionNode("action-2")];

    expect(
      namesReaching("action-1", nodes, [
        edge("e1", "action-1", "action-2"),
        edge("e2", "action-2", "action-1"),
      ])
    ).toEqual([]);
  });
});
