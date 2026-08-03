import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getUpstreamConditionFields,
  getUpstreamFields,
  getUpstreamNodes,
} from "#src/lib/upstream-node-fields";
import {
  type ConditionModel,
  EVENT_NAME_FIELD_PATH,
  serializeConditionModel,
} from "@rova/shared/conditions/conditions";
import {
  type ActionMetadata,
  emptyExtensionCatalog,
  type EventMetadata,
} from "@rova/shared/extensions/catalog";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@rova/shared/lifecycle/lifecycle-outlets";
import type { LifecycleRules } from "@rova/shared/lifecycle/lifecycle-rules";
import { isoTimestampString } from "@rova/shared/types/timestamp";
import { requireOutputFieldsFromSchema } from "@rova/shared/graph/output-fields";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

// What a node offers downstream comes off the catalog the editor fetches once
// before render: an action's own entry, and for the entry node the Events its rules
// name. A case says what the surface holds by writing this, and `vi.hoisted` is
// what lets the factory below read it.
const surface = vi.hoisted(() => ({
  actions: [] as ActionMetadata[],
  events: [] as EventMetadata[],
}));

vi.mock("#src/lib/extensions", () => ({
  getExtensionCatalog: () => ({
    ...emptyExtensionCatalog,
    actions: surface.actions,
    events: surface.events,
  }),
}));

/** One catalog action, with the fields a case cares about and defaults elsewhere. */
function anAction(
  action: Partial<ActionMetadata> & { id: string }
): ActionMetadata {
  return {
    label: action.id,
    description: "",
    category: "Custom",
    configFields: [],
    outputFields: [],
    ...action,
  };
}

function createNode(input: {
  id: string;
  type: "lifecycle" | "action";
  label: string;
  config?: Record<string, unknown>;
}): WorkflowNode {
  return {
    id: input.id,
    type: input.type,
    position: { x: 0, y: 0 },
    data: {
      label: input.label,
      type: input.type,
      config: input.config,
    },
  };
}

function createEdge(input: {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}): WorkflowEdge {
  return {
    id: input.id,
    source: input.source,
    target: input.target,
    ...(input.sourceHandle ? { sourceHandle: input.sourceHandle } : {}),
  };
}

/** One Event, its payload fields derived the way `defineEvent` derives them. */
function anEvent(input: {
  name: string;
  schema: Parameters<typeof requireOutputFieldsFromSchema>[1];
}): EventMetadata {
  return {
    name: input.name,
    label: input.name,
    payloadFields: requireOutputFieldsFromSchema(
      `Event "${input.name}"`,
      input.schema
    ),
  };
}

/** The edge a run leaves the Started outlet by, drawn to one node. */
function startedEdge(target: string): WorkflowEdge {
  return createEdge({
    id: `e-${target}`,
    source: "lifecycle-1",
    sourceHandle: LIFECYCLE_STARTED_HANDLE,
    target,
  });
}

/** An entry node whose rules start on these Events and cancel on those. */
function anEntryNode(input: {
  startEvents?: string[];
  cancelEvents?: string[];
}): WorkflowNode {
  const lifecycleRules: LifecycleRules = {
    startEvents: input.startEvents ?? [],
    cancelEvents: input.cancelEvents ?? [],
    concurrency: "unlimited",
  };

  return createNode({
    id: "lifecycle-1",
    type: "lifecycle",
    label: "Lifecycle",
    config: { lifecycleRules },
  });
}

describe("upstream-node-fields", () => {
  afterEach(() => {
    surface.actions = [];
    surface.events = [];
  });

  it("discovers transitive upstream nodes and condition fields", () => {
    surface.events = [
      anEvent({
        name: "app/appointment.created",
        schema: Schema.Struct({
          data: Schema.Struct({
            id: Schema.String.annotate({ description: "Appointment ID" }),
          }).annotate({ description: "The appointment" }),
        }),
      }),
    ];
    surface.actions = [
      anAction({
        id: "custom/call-api",
        outputFields: [
          { path: "status", description: "Response status", type: "number" },
          {
            path: "result",
            description: "Response body",
            type: "object",
          },
          {
            path: "result.total",
            description: "Total count",
            type: "number",
          },
        ],
      }),
    ];

    const nodes: WorkflowNode[] = [
      anEntryNode({ startEvents: ["app/appointment.created"] }),
      createNode({
        id: "call-1",
        type: "action",
        label: "Call API",
        config: { actionType: "custom/call-api" },
      }),
      createNode({
        id: "wait-1",
        type: "action",
        label: "Wait",
        config: { actionType: "Wait" },
      }),
      createNode({
        id: "condition-1",
        type: "action",
        label: "Condition",
        config: { actionType: "Condition" },
      }),
    ];

    const edges: WorkflowEdge[] = [
      createEdge({
        id: "e1",
        source: "lifecycle-1",
        sourceHandle: LIFECYCLE_STARTED_HANDLE,
        target: "call-1",
      }),
      createEdge({ id: "e2", source: "call-1", target: "wait-1" }),
      createEdge({ id: "e3", source: "wait-1", target: "condition-1" }),
    ];

    const upstreamNodes = getUpstreamNodes({
      currentNodeId: "condition-1",
      nodes,
      edges,
    });
    expect(upstreamNodes.map((node) => node.id)).toEqual([
      "lifecycle-1",
      "call-1",
      "wait-1",
    ]);

    const fields = getUpstreamConditionFields({
      currentNodeId: "condition-1",
      nodes,
      edges,
    });

    expect(fields.some((field) => field.path === "data.id")).toBe(true);
    expect(fields.some((field) => field.path === "result.total")).toBe(true);
    expect(fields.some((field) => field.path === "status")).toBe(true);
  });

  it("offers a Start Event's datetime fields as timestamps", () => {
    // The acceptance case for the condition builder: a field an Event declared as
    // a moment in time arrives typed `timestamp`, which is what gets it the
    // before/after operators rather than string ones.
    surface.events = [
      anEvent({
        name: "app/appointment.created",
        schema: Schema.Struct({
          startsAt: isoTimestampString("When the appointment starts"),
          occurredAt: isoTimestampString("When the event was raised"),
          patientName: Schema.String.annotate({ description: "Patient name" }),
        }),
      }),
    ];

    const fields = getUpstreamConditionFields({
      currentNodeId: "condition-1",
      nodes: [
        anEntryNode({ startEvents: ["app/appointment.created"] }),
        createNode({
          id: "condition-1",
          type: "action",
          label: "Condition",
          config: { actionType: "Condition" },
        }),
      ],
      edges: [
        createEdge({
          id: "e1",
          source: "lifecycle-1",
          sourceHandle: LIFECYCLE_STARTED_HANDLE,
          target: "condition-1",
        }),
      ],
    });

    expect(fields).toEqual([
      expect.objectContaining({ path: "occurredAt", type: "timestamp" }),
      expect.objectContaining({ path: "patientName", type: "string" }),
      expect.objectContaining({ path: "startsAt", type: "timestamp" }),
    ]);
  });

  it("offers a node behind the Canceled outlet the Cancel Events' fields", () => {
    surface.events = [
      anEvent({
        name: "app/appointment.created",
        schema: Schema.Struct({
          occurredAt: isoTimestampString("When the event was raised"),
          bookedBy: Schema.String.annotate({ description: "Who booked it" }),
        }),
      }),
      anEvent({
        name: "app/appointment.canceled",
        schema: Schema.Struct({
          occurredAt: isoTimestampString("When the event was raised"),
          reason: Schema.String.annotate({
            description: "Why it was called off",
          }),
        }),
      }),
    ];

    const nodes: WorkflowNode[] = [
      anEntryNode({
        startEvents: ["app/appointment.created"],
        cancelEvents: ["app/appointment.canceled"],
      }),
      createNode({
        id: "on-cancel",
        type: "action",
        label: "Apologise",
        config: { actionType: "custom/notify" },
      }),
    ];

    const edges: WorkflowEdge[] = [
      createEdge({
        id: "e1",
        source: "lifecycle-1",
        sourceHandle: LIFECYCLE_CANCELED_HANDLE,
        target: "on-cancel",
      }),
    ];

    // Behind Canceled: the Cancel Event's own fields, including the one the Start
    // Event never declares. One Event reaches this node, so the fields stay under
    // the node's own name.
    expect(
      getUpstreamFields({ currentNodeId: "on-cancel", nodes, edges }).map(
        (field) => [field.path, field.sourceNodeName]
      )
    ).toEqual([
      ["occurredAt", "Lifecycle"],
      ["reason", "Lifecycle"],
    ]);
  });

  // The reported bug: two Cancel Events of unrelated shape intersected to
  // nothing, and the panel said there were no upstream fields at all.
  it("offers every Cancel Event's fields, each under the Events declaring it", () => {
    surface.events = [
      anEvent({
        name: "app/appointment.created",
        schema: Schema.Struct({
          occurredAt: isoTimestampString("When the event was raised"),
        }),
      }),
      anEvent({
        name: "app/appointment.canceled",
        schema: Schema.Struct({
          occurredAt: isoTimestampString("When the event was raised"),
          reason: Schema.String.annotate({ description: "Why" }),
        }),
      }),
      anEvent({
        name: "app/appointment.rescheduled",
        schema: Schema.Struct({
          occurredAt: isoTimestampString("When the event was raised"),
          rescheduledBy: Schema.String.annotate({
            description: "Who moved it",
          }),
        }),
      }),
    ];

    const nodes: WorkflowNode[] = [
      anEntryNode({
        startEvents: ["app/appointment.created"],
        cancelEvents: [
          "app/appointment.canceled",
          "app/appointment.rescheduled",
        ],
      }),
      createNode({
        id: "on-cancel",
        type: "action",
        label: "Decide",
        config: { actionType: "Condition" },
      }),
    ];

    const edges: WorkflowEdge[] = [
      createEdge({
        id: "e1",
        source: "lifecycle-1",
        sourceHandle: LIFECYCLE_CANCELED_HANDLE,
        target: "on-cancel",
      }),
    ];

    expect(
      getUpstreamFields({ currentNodeId: "on-cancel", nodes, edges }).map(
        (field) => [field.path, field.sourceNodeName]
      )
    ).toEqual([
      ["occurredAt", "Carried by every Event"],
      ["reason", "app/appointment.canceled"],
      ["rescheduledBy", "app/appointment.rescheduled"],
    ]);
  });

  // Two Start Events is how one workflow answers an appointment being booked and
  // being moved, so a node behind Started faces the same question as one behind
  // Canceled.
  it("offers a node behind Started the union of the Start Events' fields", () => {
    surface.events = [
      anEvent({
        name: "app/appointment.created",
        schema: Schema.Struct({
          appointmentId: Schema.String.annotate({ description: "Which one" }),
          bookedBy: Schema.String.annotate({ description: "Who booked it" }),
        }),
      }),
      anEvent({
        name: "app/appointment.rescheduled",
        schema: Schema.Struct({
          appointmentId: Schema.String.annotate({ description: "Which one" }),
          movedBy: Schema.String.annotate({ description: "Who moved it" }),
        }),
      }),
    ];

    const nodes: WorkflowNode[] = [
      anEntryNode({
        startEvents: ["app/appointment.created", "app/appointment.rescheduled"],
      }),
      createNode({
        id: "action-1",
        type: "action",
        label: "Decide",
        config: { actionType: "Condition" },
      }),
    ];

    expect(
      getUpstreamFields({
        currentNodeId: "action-1",
        nodes,
        edges: [startedEdge("action-1")],
      }).map((field) => [field.path, field.sourceNodeName])
    ).toEqual([
      ["appointmentId", "Carried by every Event"],
      ["bookedBy", "app/appointment.created"],
      ["movedBy", "app/appointment.rescheduled"],
    ]);
  });

  // A Condition that splits the Cancel Events leaves one Event on each of its
  // lines, so the node behind a line reads that Event's payload alone and has
  // nothing left to select between.
  it("offers one Event's fields behind a Condition that named it", () => {
    surface.events = [
      anEvent({
        name: "app/appointment.canceled",
        schema: Schema.Struct({
          appointmentId: Schema.String.annotate({ description: "Which one" }),
          reason: Schema.String.annotate({ description: "Why" }),
        }),
      }),
      anEvent({
        name: "app/appointment.rescheduled",
        schema: Schema.Struct({
          appointmentId: Schema.String.annotate({ description: "Which one" }),
          movedBy: Schema.String.annotate({ description: "Who moved it" }),
        }),
      }),
    ];

    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "rule-1",
              field: EVENT_NAME_FIELD_PATH,
              fieldType: "string",
              operator: "equals",
              value: "app/appointment.canceled",
            },
          ],
        },
      ],
    };

    const nodes: WorkflowNode[] = [
      anEntryNode({
        cancelEvents: [
          "app/appointment.canceled",
          "app/appointment.rescheduled",
        ],
      }),
      createNode({
        id: "which-1",
        type: "action",
        label: "Which Event",
        config: {
          actionType: "Condition",
          conditionModel: serializeConditionModel(model),
        },
      }),
      createNode({
        id: "on-canceled",
        type: "action",
        label: "Apologise",
        config: { actionType: "Condition" },
      }),
    ];

    const edges: WorkflowEdge[] = [
      createEdge({
        id: "e1",
        source: "lifecycle-1",
        sourceHandle: LIFECYCLE_CANCELED_HANDLE,
        target: "which-1",
      }),
      createEdge({
        id: "e2",
        source: "which-1",
        sourceHandle: "true",
        target: "on-canceled",
      }),
    ];

    // One Event reaching it, so its fields sit under the node's own name rather
    // than in per-Event sections.
    expect(
      getUpstreamFields({ currentNodeId: "on-canceled", nodes, edges })
        .filter((field) => field.sourceNodeId === "lifecycle-1")
        .map((field) => [field.path, field.sourceNodeName])
    ).toEqual([
      ["appointmentId", "Lifecycle"],
      ["reason", "Lifecycle"],
    ]);

    expect(
      getUpstreamConditionFields({
        currentNodeId: "on-canceled",
        nodes,
        edges,
      }).some((field) => field.path === EVENT_NAME_FIELD_PATH)
    ).toBe(false);
  });

  it("offers the Event name where more than one Event reaches the node", () => {
    surface.events = [
      anEvent({
        name: "app/appointment.canceled",
        schema: Schema.Struct({
          reason: Schema.String.annotate({ description: "Why" }),
        }),
      }),
      anEvent({
        name: "app/appointment.rescheduled",
        schema: Schema.Struct({
          rescheduledBy: Schema.String.annotate({
            description: "Who moved it",
          }),
        }),
      }),
    ];

    const nodes: WorkflowNode[] = [
      anEntryNode({
        cancelEvents: [
          "app/appointment.canceled",
          "app/appointment.rescheduled",
        ],
      }),
      createNode({
        id: "on-cancel",
        type: "action",
        label: "Decide",
        config: { actionType: "Condition" },
      }),
    ];

    const edges: WorkflowEdge[] = [
      createEdge({
        id: "e1",
        source: "lifecycle-1",
        sourceHandle: LIFECYCLE_CANCELED_HANDLE,
        target: "on-cancel",
      }),
    ];

    const eventName = getUpstreamConditionFields({
      currentNodeId: "on-cancel",
      nodes,
      edges,
    }).find((field) => field.path === "$event.name");

    expect(eventName).toMatchObject({
      label: "Event name",
      type: "string",
      enumValues: ["app/appointment.canceled", "app/appointment.rescheduled"],
    });
  });

  it("leaves the Event name out where one Event reaches the node", () => {
    // Nothing to select between: every run arriving here came on that Event.
    surface.events = [
      anEvent({
        name: "app/appointment.created",
        schema: Schema.Struct({
          bookedBy: Schema.String.annotate({ description: "Who booked it" }),
        }),
      }),
    ];

    const fields = getUpstreamConditionFields({
      currentNodeId: "action-1",
      nodes: [
        anEntryNode({ startEvents: ["app/appointment.created"] }),
        createNode({
          id: "action-1",
          type: "action",
          label: "Condition",
          config: { actionType: "Condition" },
        }),
      ],
      edges: [startedEdge("action-1")],
    });

    expect(fields.map((field) => field.path)).toEqual(["bookedBy"]);
  });

  it("offers nothing when it cannot name the Start Event", () => {
    // A rules declaration naming an Event this build never heard of is refused at
    // save, so it describes a graph that cannot run and there is no payload to
    // promise.
    surface.events = [];

    expect(
      getUpstreamFields({
        currentNodeId: "action-1",
        nodes: [
          anEntryNode({ startEvents: ["app/never.declared"] }),
          createNode({
            id: "action-1",
            type: "action",
            label: "Send SMS",
            config: { actionType: "custom/unknown" },
          }),
        ],
        edges: [startedEdge("action-1")],
      })
    ).toEqual([]);
  });

  it("marks a path its Events type differently as unusable", () => {
    // Two Cancel Events reach this node and disagree about what `occurredAt` is.
    // The type decides a condition row's operators and what a typed target
    // accepts, so a path with two of them has no answer to offer.
    surface.events = [
      anEvent({
        name: "app/appointment.canceled",
        schema: Schema.Struct({
          occurredAt: isoTimestampString("When the event was raised"),
        }),
      }),
      anEvent({
        name: "app/appointment.rescheduled",
        schema: Schema.Struct({
          occurredAt: Schema.String.annotate({ description: "When, roughly" }),
        }),
      }),
    ];

    const nodes: WorkflowNode[] = [
      anEntryNode({
        cancelEvents: [
          "app/appointment.canceled",
          "app/appointment.rescheduled",
        ],
      }),
      createNode({
        id: "on-cancel",
        type: "action",
        label: "Apologise",
        config: { actionType: "custom/unknown" },
      }),
    ];

    const edges: WorkflowEdge[] = [
      createEdge({
        id: "e1",
        source: "lifecycle-1",
        sourceHandle: LIFECYCLE_CANCELED_HANDLE,
        target: "on-cancel",
      }),
    ];

    expect(
      getUpstreamFields({ currentNodeId: "on-cancel", nodes, edges })
    ).toEqual([
      {
        path: "occurredAt",
        description: "When the event was raised",
        sourceNodeId: "lifecycle-1",
        sourceNodeName: "Carried by every Event",
        typeClash: {
          types: ["timestamp", "string"],
          events: ["app/appointment.canceled", "app/appointment.rescheduled"],
        },
      },
    ]);

    // A rule cannot be built over a path with no type, so the condition builder
    // leaves it out rather than offering operators it cannot answer. What stays
    // is the field a builder splits the Events on.
    expect(
      getUpstreamConditionFields({
        currentNodeId: "on-cancel",
        nodes,
        edges,
      }).map((field) => field.path)
    ).toEqual([EVENT_NAME_FIELD_PATH]);
  });

  it("marks a field only some Start Events declare as nullable", () => {
    // The superset case: a rescheduled appointment carries where it moved from
    // and a created one does not, so a run can reach this node without the path.
    surface.events = [
      anEvent({
        name: "app/appointment.created",
        schema: Schema.Struct({
          appointmentId: Schema.String.annotate({ description: "Which one" }),
        }),
      }),
      anEvent({
        name: "app/appointment.rescheduled",
        schema: Schema.Struct({
          appointmentId: Schema.String.annotate({ description: "Which one" }),
          previousStartsAt: isoTimestampString("Where it moved from"),
        }),
      }),
    ];

    const nodes: WorkflowNode[] = [
      anEntryNode({
        startEvents: ["app/appointment.created", "app/appointment.rescheduled"],
      }),
      createNode({
        id: "action-1",
        type: "action",
        label: "Decide",
        config: { actionType: "Condition" },
      }),
    ];

    const fields = getUpstreamConditionFields({
      currentNodeId: "action-1",
      nodes,
      edges: [startedEdge("action-1")],
    });

    expect(fields).toContainEqual(
      expect.objectContaining({
        path: "previousStartsAt",
        type: "timestamp",
        nullable: true,
      })
    );
    // The path both Events declare stays guaranteed, which is what keeps the
    // is-set operators off its row.
    expect(
      fields.find((field) => field.path === "appointmentId")?.nullable
    ).toBeUndefined();
  });

  it("offers nothing from an entry node no outlet connects it to", () => {
    // The save refuses an entry-node edge that names no outlet, so a graph
    // carrying one cannot run and there is no payload to promise.
    surface.events = [
      anEvent({
        name: "app/appointment.created",
        schema: Schema.Struct({
          occurredAt: isoTimestampString("When the event was raised"),
        }),
      }),
    ];

    const fields = getUpstreamFields({
      currentNodeId: "action-1",
      nodes: [
        anEntryNode({ startEvents: ["app/appointment.created"] }),
        createNode({
          id: "action-1",
          type: "action",
          label: "Send SMS",
          config: { actionType: "custom/unknown" },
        }),
      ],
      edges: [
        createEdge({ id: "e1", source: "lifecycle-1", target: "action-1" }),
      ],
    });

    expect(fields).toEqual([]);
  });

  it("surfaces an action field with no declared type as a string", () => {
    surface.actions = [
      anAction({
        id: "custom/test-action",
        label: "Test Action",
        outputFields: [
          { path: "appointmentId", description: "Appointment ID" },
          { path: "status", description: "Status" },
        ],
      }),
    ];

    const nodes: WorkflowNode[] = [
      createNode({
        id: "lifecycle-1",
        type: "lifecycle",
        label: "Lifecycle",
        config: {},
      }),
      createNode({
        id: "action-1",
        type: "action",
        label: "Test Action",
        config: { actionType: "custom/test-action" },
      }),
      createNode({
        id: "condition-1",
        type: "action",
        label: "Condition",
        config: { actionType: "Condition" },
      }),
    ];

    const edges: WorkflowEdge[] = [
      createEdge({ id: "e1", source: "lifecycle-1", target: "action-1" }),
      createEdge({ id: "e2", source: "action-1", target: "condition-1" }),
    ];

    const fields = getUpstreamConditionFields({
      currentNodeId: "condition-1",
      nodes,
      edges,
    });

    const appointmentField = fields.find((f) => f.path === "appointmentId");
    expect(appointmentField).toBeDefined();
    expect(appointmentField?.type).toBe("string");

    const statusField = fields.find((f) => f.path === "status");
    expect(statusField).toBeDefined();
    expect(statusField?.type).toBe("string");
  });

  it("prefixes a nested action field with the node that produces it", () => {
    // The whole chain in one case: an output schema that nests, the derivation
    // that descends into it, and the node label the editor puts in front of the
    // path. What the picker inserts is `{{@node:Label.appointment.id}}`, so the
    // leaf has to arrive here as `appointment.id` rather than as `appointment`.
    surface.actions = [
      anAction({
        id: "custom/nested-action",
        label: "Nested Action",
        outputFields: requireOutputFieldsFromSchema(
          'Action "custom/nested-action"',
          Schema.Struct({
            appointment: Schema.Struct({
              id: Schema.String.annotate({ description: "Appointment ID" }),
            }).annotate({ description: "The appointment" }),
          })
        ),
      }),
    ];

    const nodes: WorkflowNode[] = [
      createNode({
        id: "action-1",
        type: "action",
        label: "Load Appointment",
        config: { actionType: "custom/nested-action" },
      }),
      createNode({
        id: "action-2",
        type: "action",
        label: "Cancel Appointment",
        config: { actionType: "custom/notify" },
      }),
    ];

    const fields = getUpstreamFields({
      currentNodeId: "action-2",
      nodes,
      edges: [createEdge({ id: "e1", source: "action-1", target: "action-2" })],
    });

    expect(fields).toEqual([
      {
        path: "appointment",
        description: "The appointment",
        type: "object",
        sourceNodeId: "action-1",
        sourceNodeName: "Load Appointment",
      },
      {
        path: "appointment.id",
        description: "Appointment ID",
        type: "string",
        sourceNodeId: "action-1",
        sourceNodeName: "Load Appointment",
      },
    ]);
  });

  it("offers nothing from an upstream node whose action type the catalog cannot find", () => {
    // A stale graph naming a plugin action this build no longer ships. There is
    // no schema to read fields from, so the picker offers nothing rather than a
    // placeholder that resolves to nothing at run time.
    const nodes: WorkflowNode[] = [
      createNode({
        id: "action-1",
        type: "action",
        label: "Removed Action",
        config: { actionType: "custom/gone" },
      }),
      createNode({
        id: "action-2",
        type: "action",
        label: "Condition",
        config: { actionType: "Condition" },
      }),
    ];

    const fields = getUpstreamFields({
      currentNodeId: "action-2",
      nodes,
      edges: [createEdge({ id: "e1", source: "action-1", target: "action-2" })],
    });

    expect(fields).toEqual([]);
  });

  it("includes only condition-compatible primitive fields", () => {
    surface.actions = [
      anAction({
        id: "custom/list-items",
        outputFields: [
          { path: "items", description: "The items found", type: "array" },
          { path: "count", description: "Number of items", type: "number" },
        ],
      }),
    ];

    const nodes: WorkflowNode[] = [
      createNode({
        id: "lifecycle-1",
        type: "lifecycle",
        label: "Webhook",
        config: {},
      }),
      createNode({
        id: "list-1",
        type: "action",
        label: "List",
        config: { actionType: "custom/list-items" },
      }),
      createNode({
        id: "condition-1",
        type: "action",
        label: "Condition",
        config: { actionType: "Condition" },
      }),
    ];

    const edges: WorkflowEdge[] = [
      createEdge({ id: "e1", source: "lifecycle-1", target: "list-1" }),
      createEdge({ id: "e2", source: "list-1", target: "condition-1" }),
    ];

    const fields = getUpstreamConditionFields({
      currentNodeId: "condition-1",
      nodes,
      edges,
    });

    expect(fields.some((field) => field.path === "count")).toBe(true);
    expect(fields.some((field) => field.path === "items")).toBe(false);
  });
});
