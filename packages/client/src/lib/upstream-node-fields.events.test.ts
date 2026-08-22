import { Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getUpstreamConditionFields,
  getUpstreamFields,
} from "#src/lib/upstream-node-fields";
import {
  type ConditionModel,
  EVENT_NAME_FIELD_PATH,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { isoTimestampString } from "@wfgraph/shared/types/timestamp";
import {
  anEntryNode,
  anEvent,
  createEdge,
  createNode,
  startedEdge,
  createSurface,
  type MutableCatalog,
} from "#src/lib/upstream-node-fields-test-support";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

describe("upstream-node-fields events", () => {
  // A catalog of its own per case: nothing here outlives the `it` that
  // wrote it, which is what keeps one file's Events out of another's.
  let surface: MutableCatalog;
  beforeEach(() => {
    surface = createSurface();
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
      catalog: surface,
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
      getUpstreamFields({
        catalog: surface,
        currentNodeId: "on-cancel",
        nodes,
        edges,
      }).map((field) => [field.path, field.sourceNodeName])
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
      getUpstreamFields({
        catalog: surface,
        currentNodeId: "on-cancel",
        nodes,
        edges,
      }).map((field) => [field.path, field.sourceNodeName])
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
        catalog: surface,
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
      getUpstreamFields({
        catalog: surface,
        currentNodeId: "on-canceled",
        nodes,
        edges,
      })
        .filter((field) => field.sourceNodeId === "lifecycle-1")
        .map((field) => [field.path, field.sourceNodeName])
    ).toEqual([
      ["appointmentId", "Lifecycle"],
      ["reason", "Lifecycle"],
    ]);

    expect(
      getUpstreamConditionFields({
        catalog: surface,
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
      catalog: surface,
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
      catalog: surface,
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
        catalog: surface,
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
      getUpstreamFields({
        catalog: surface,
        currentNodeId: "on-cancel",
        nodes,
        edges,
      })
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
        catalog: surface,
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
      catalog: surface,
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
      catalog: surface,
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

  it("offers a node below a Wait the Events that Wait parks on", () => {
    // The Start Event put the run at the Wait; the Events the Wait wakes on
    // are what a node below it may split or address.
    surface.events = [
      anEvent({
        name: "app/appointment.created",
        schema: Schema.Struct({
          appointmentId: Schema.String.annotate({
            description: "Appointment",
          }),
        }),
      }),
      anEvent({
        name: "billing/payment.settled",
        schema: Schema.Struct({
          amount: Schema.String.annotate({ description: "Amount" }),
        }),
      }),
      anEvent({
        name: "billing/payment.failed",
        schema: Schema.Struct({
          reason: Schema.String.annotate({ description: "Why" }),
        }),
      }),
    ];

    const nodes: WorkflowNode[] = [
      anEntryNode({ startEvents: ["app/appointment.created"] }),
      createNode({
        id: "wait-1",
        type: "action",
        label: "Wait",
        config: {
          actionType: "Wait",
          waitMode: "event",
          waitFor: [
            { event: "billing/payment.settled" },
            { event: "billing/payment.failed" },
          ],
        },
      }),
      createNode({
        id: "after-wait",
        type: "action",
        label: "Decide",
        config: { actionType: "Condition" },
      }),
    ];
    const edges: WorkflowEdge[] = [
      startedEdge("wait-1"),
      createEdge({ id: "e2", source: "wait-1", target: "after-wait" }),
    ];

    const fields = getUpstreamConditionFields({
      catalog: surface,
      currentNodeId: "after-wait",
      nodes,
      edges,
    });

    expect(
      fields
        .filter(
          (field) =>
            field.sourceNodeId === "lifecycle-1" &&
            field.path !== EVENT_NAME_FIELD_PATH
        )
        .map((field) => field.path)
    ).toEqual(["amount", "reason"]);
    expect(
      fields.find((field) => field.path === EVENT_NAME_FIELD_PATH)
    ).toMatchObject({
      enumValues: ["billing/payment.settled", "billing/payment.failed"],
    });
  });
});
