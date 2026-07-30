import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getUpstreamConditionFields,
  getUpstreamFields,
  getUpstreamNodes,
} from "#src/lib/upstream-node-fields";
import {
  type ActionMetadata,
  emptyExtensionCatalog,
} from "@rova/shared/extensions/catalog";
import { requireOutputFieldsFromSchema } from "@rova/shared/workflow/output-fields";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/workflow/types";

// What a node offers downstream comes off the action's entry in the catalog, which
// the editor fetches once before render. A case says what the surface holds by
// writing this, and `vi.hoisted` is what lets the factory below read it.
const surface = vi.hoisted(() => ({
  actions: [] as ActionMetadata[],
}));

vi.mock("#src/lib/extensions", () => ({
  getExtensionCatalog: () => ({
    ...emptyExtensionCatalog,
    actions: surface.actions,
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
  type: "trigger" | "action";
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
}): WorkflowEdge {
  return {
    id: input.id,
    source: input.source,
    target: input.target,
  };
}

describe("upstream-node-fields", () => {
  afterEach(() => {
    surface.actions = [];
  });

  it("discovers transitive upstream nodes and condition fields", () => {
    const nodes: WorkflowNode[] = [
      createNode({
        id: "trigger-1",
        type: "trigger",
        label: "Webhook",
        config: {
          webhookOutputSchema: JSON.stringify([
            {
              name: "data",
              type: "object",
              fields: [{ name: "id", type: "string" }],
            },
          ]),
        },
      }),
      createNode({
        id: "http-1",
        type: "action",
        label: "HTTP",
        config: {
          actionType: "HTTP Request",
          httpOutputSchema: JSON.stringify([
            {
              name: "data",
              type: "object",
              fields: [{ name: "total", type: "number" }],
            },
          ]),
        },
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
      createEdge({ id: "e1", source: "trigger-1", target: "http-1" }),
      createEdge({ id: "e2", source: "http-1", target: "wait-1" }),
      createEdge({ id: "e3", source: "wait-1", target: "condition-1" }),
    ];

    const upstreamNodes = getUpstreamNodes({
      currentNodeId: "condition-1",
      nodes,
      edges,
    });
    expect(upstreamNodes.map((node) => node.id)).toEqual([
      "trigger-1",
      "http-1",
      "wait-1",
    ]);

    const fields = getUpstreamConditionFields({
      currentNodeId: "condition-1",
      nodes,
      edges,
    });

    expect(fields.some((field) => field.path === "data.id")).toBe(true);
    expect(fields.some((field) => field.path === "data.total")).toBe(true);
    expect(fields.some((field) => field.path === "status")).toBe(true);
  });

  it("maps fallback trigger timestamp and boolean fields", () => {
    const nodes: WorkflowNode[] = [
      createNode({
        id: "trigger-1",
        type: "trigger",
        label: "Webhook",
        config: {},
      }),
      createNode({
        id: "condition-1",
        type: "action",
        label: "Condition",
        config: { actionType: "Condition" },
      }),
    ];

    const edges: WorkflowEdge[] = [
      createEdge({ id: "e1", source: "trigger-1", target: "condition-1" }),
    ];

    const fields = getUpstreamConditionFields({
      currentNodeId: "condition-1",
      nodes,
      edges,
    });

    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "triggered", type: "boolean" }),
        expect.objectContaining({ path: "timestamp", type: "timestamp" }),
      ])
    );
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
        id: "trigger-1",
        type: "trigger",
        label: "Trigger",
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
      createEdge({ id: "e1", source: "trigger-1", target: "action-1" }),
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
        config: { actionType: "HTTP Request" },
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

  it("includes only condition-compatible primitive fields", () => {
    const nodes: WorkflowNode[] = [
      createNode({
        id: "trigger-1",
        type: "trigger",
        label: "Webhook",
        config: {},
      }),
      createNode({
        id: "db-1",
        type: "action",
        label: "DB",
        config: { actionType: "Database Query" },
      }),
      createNode({
        id: "condition-1",
        type: "action",
        label: "Condition",
        config: { actionType: "Condition" },
      }),
    ];

    const edges: WorkflowEdge[] = [
      createEdge({ id: "e1", source: "trigger-1", target: "db-1" }),
      createEdge({ id: "e2", source: "db-1", target: "condition-1" }),
    ];

    const fields = getUpstreamConditionFields({
      currentNodeId: "condition-1",
      nodes,
      edges,
    });

    expect(fields.some((field) => field.path === "count")).toBe(true);
    expect(fields.some((field) => field.path === "rows")).toBe(false);
  });
});
