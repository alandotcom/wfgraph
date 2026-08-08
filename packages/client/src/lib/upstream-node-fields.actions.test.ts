import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  getUpstreamConditionFields,
  getUpstreamFields,
} from "#src/lib/upstream-node-fields";
import { requireOutputFieldsFromSchema } from "@wfgraph/shared/graph/output-fields";
import {
  anAction,
  anEntryNode,
  createEdge,
  createNode,
  surface,
} from "#src/lib/upstream-node-fields-test-support";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

describe("upstream-node-fields actions", () => {
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
      catalog: surface,
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
      catalog: surface,
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
      catalog: surface,
      currentNodeId: "action-2",
      nodes,
      edges: [createEdge({ id: "e1", source: "action-1", target: "action-2" })],
    });

    expect(fields).toEqual([]);
  });

  // Output fields declare showWhen the same way config fields do. A delay Wait
  // leaves waitMode unset or "delay", so event-only paths stay out of the picker.
  it("offers only delay Wait outputs when the upstream Wait is on a clock", () => {
    const eventOnly = { field: "waitMode", equals: "event" } as const;
    surface.actions = [
      anAction({
        id: "Wait",
        label: "Wait",
        outputFields: [
          { path: "waitType", type: "string" },
          { path: "timedOut", type: "boolean", showWhen: eventOnly },
          { path: "resumedAt", type: "timestamp" },
          { path: "event", type: "string", showWhen: eventOnly },
          { path: "payload", type: "object", showWhen: eventOnly },
        ],
      }),
    ];

    const nodes: WorkflowNode[] = [
      anEntryNode({ startEvents: [] }),
      createNode({
        id: "wait-1",
        type: "action",
        label: "Wait",
        config: { actionType: "Wait", waitMode: "delay", waitDuration: "30s" },
      }),
      createNode({
        id: "condition-1",
        type: "action",
        label: "Condition",
        config: { actionType: "Condition" },
      }),
    ];
    const edges: WorkflowEdge[] = [
      createEdge({ id: "e1", source: "lifecycle-1", target: "wait-1" }),
      createEdge({ id: "e2", source: "wait-1", target: "condition-1" }),
    ];

    const paths = getUpstreamConditionFields({
      catalog: surface,
      currentNodeId: "condition-1",
      nodes,
      edges,
    }).map((field) => field.path);

    expect(paths).toEqual(["resumedAt", "waitType"]);
  });

  it("offers event Wait outputs when the upstream Wait parks on an Event", () => {
    const eventOnly = { field: "waitMode", equals: "event" } as const;
    surface.actions = [
      anAction({
        id: "Wait",
        label: "Wait",
        outputFields: [
          { path: "waitType", type: "string" },
          { path: "timedOut", type: "boolean", showWhen: eventOnly },
          { path: "resumedAt", type: "timestamp" },
          { path: "event", type: "string", showWhen: eventOnly },
          { path: "payload", type: "object", showWhen: eventOnly },
        ],
      }),
    ];

    const nodes: WorkflowNode[] = [
      anEntryNode({ startEvents: [] }),
      createNode({
        id: "wait-1",
        type: "action",
        label: "Wait",
        config: {
          actionType: "Wait",
          waitMode: "event",
          waitFor: [{ event: "billing/payment.settled" }],
          waitTimeout: "7d",
        },
      }),
      createNode({
        id: "condition-1",
        type: "action",
        label: "Condition",
        config: { actionType: "Condition" },
      }),
    ];
    const edges: WorkflowEdge[] = [
      createEdge({ id: "e1", source: "lifecycle-1", target: "wait-1" }),
      createEdge({ id: "e2", source: "wait-1", target: "condition-1" }),
    ];

    const paths = getUpstreamConditionFields({
      catalog: surface,
      currentNodeId: "condition-1",
      nodes,
      edges,
    }).map((field) => field.path);

    // payload is object and stays out of the condition vocabulary.
    expect(paths).toEqual(["event", "resumedAt", "timedOut", "waitType"]);
  });
});
