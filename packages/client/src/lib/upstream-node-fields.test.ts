import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTriggerDefinition } from "#src/lib/runtime-extensions";
import {
  getUpstreamConditionFields,
  getUpstreamNodes,
} from "#src/lib/upstream-node-fields";
import {
  clearRuntimeActions,
  registerRuntimeAction,
} from "@rova/shared/workflow/action-registry";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/workflow/types";

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
  // The runtime action registry is module-level state, so a case that registers
  // an action has to hand it back before the next one runs. The doMock below is
  // the same problem one level up: left installed, it would hold the stubbed
  // runtime-extensions module and its emptied registry over every later case.
  afterEach(() => {
    clearRuntimeActions();
    vi.doUnmock("#src/lib/runtime-extensions");
    vi.resetModules();
  });

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
        { path: "appointmentId", description: "Appointment ID" },
        { path: "status", description: "Status" },
      ],
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

  it("surfaces custom trigger schema fields via runtime trigger outputFields", async () => {
    const mockTrigger: RuntimeTriggerDefinition = {
      type: "DonorEligibility",
      label: "Donor Eligibility",
      executionType: "webhook",
      outputFields: [
        { path: "donorUuid", description: "Donor UUID", type: "string" },
        { path: "status", description: "Eligibility status", type: "string" },
        { path: "score", description: "Eligibility score", type: "number" },
      ],
    };

    // vi.doMock rather than vi.mock: only this case wants the trigger lookup
    // stubbed, and vi.mock would be hoisted to the top of the file and apply to
    // every case in it. Resetting the registry first makes the re-import below
    // evaluate the subject afresh against the stub.
    vi.resetModules();
    vi.doMock("#src/lib/runtime-extensions", () => ({
      findRuntimeTrigger: (type: string) =>
        type === "DonorEligibility" ? mockTrigger : undefined,
      getRuntimeTriggers: () => [],
      hydrateRuntimeExtensionsFromApi: () => Promise.resolve(),
    }));

    const { getNodeOutputFields: getNodeOutputFieldsMocked } =
      await import("#src/lib/upstream-node-fields");

    const triggerNode = createNode({
      id: "trigger-1",
      type: "trigger",
      label: "DonorEligibility",
      config: { triggerType: "DonorEligibility" },
    });

    const fields = getNodeOutputFieldsMocked(triggerNode);

    // Should include default trigger fields
    expect(fields.some((f: { path: string }) => f.path === "triggered")).toBe(
      true
    );
    expect(fields.some((f: { path: string }) => f.path === "timestamp")).toBe(
      true
    );
    expect(fields.some((f: { path: string }) => f.path === "input")).toBe(true);

    // Should include custom trigger schema fields
    expect(fields.some((f: { path: string }) => f.path === "donorUuid")).toBe(
      true
    );
    expect(fields.some((f: { path: string }) => f.path === "status")).toBe(
      true
    );
    expect(fields.some((f: { path: string }) => f.path === "score")).toBe(true);
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
