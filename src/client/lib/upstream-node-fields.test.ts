import { afterEach, describe, expect, it } from "bun:test";
import {
  getUpstreamConditionFields,
  getUpstreamNodes,
} from "@/client/lib/upstream-node-fields";
import { clearRuntimeActions, registerRuntimeAction } from "@/plugins/registry";
import type { WorkflowEdge, WorkflowNode } from "@/shared/workflow/types";

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
  it("discovers transitive upstream nodes and condition fields", () => {
    const nodes: WorkflowNode[] = [
      createNode({
        id: "trigger-1",
        type: "trigger",
        label: "Webhook",
        config: {
          triggerType: "Webhook",
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
        config: {
          triggerType: "Webhook",
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

  it("surfaces runtime action fields without explicit type as string", () => {
    registerRuntimeAction({
      id: "custom/test-action",
      label: "Test Action",
      description: "Action with typeless output fields",
      category: "Custom",
      outputFields: [
        { field: "appointmentId", description: "Appointment ID" },
        { field: "status", description: "Status" },
      ],
    });

    afterEach(() => {
      clearRuntimeActions();
    });

    const nodes: WorkflowNode[] = [
      createNode({
        id: "trigger-1",
        type: "trigger",
        label: "Webhook",
        config: { triggerType: "Webhook" },
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

  it("includes only condition-compatible primitive fields", () => {
    const nodes: WorkflowNode[] = [
      createNode({
        id: "trigger-1",
        type: "trigger",
        label: "Webhook",
        config: {
          triggerType: "Webhook",
        },
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
