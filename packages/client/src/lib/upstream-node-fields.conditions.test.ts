import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  getUpstreamConditionFields,
  getUpstreamNodes,
} from "#src/lib/upstream-node-fields";
import {
  anAction,
  anEntryNode,
  anEvent,
  createEdge,
  createNode,
  surface,
} from "#src/lib/upstream-node-fields-test-support";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
describe("upstream-node-fields conditions", () => {
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
      catalog: surface,
      currentNodeId: "condition-1",
      nodes,
      edges,
    });

    expect(fields.some((field) => field.path === "data.id")).toBe(true);
    expect(fields.some((field) => field.path === "result.total")).toBe(true);
    expect(fields.some((field) => field.path === "status")).toBe(true);
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
      catalog: surface,
      currentNodeId: "condition-1",
      nodes,
      edges,
    });

    expect(fields.some((field) => field.path === "count")).toBe(true);
    expect(fields.some((field) => field.path === "items")).toBe(false);
  });

  // Output fields declare showWhen the same way config fields do. A delay Wait
  // leaves waitMode unset or "delay", so event-only paths stay out of the picker.
});
