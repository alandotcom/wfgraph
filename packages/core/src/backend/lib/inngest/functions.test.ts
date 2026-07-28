import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CURRENT_WORKFLOW_NAME } from "@/backend/lib/workflow-constants";
import { createSerializedWorkflowGraph } from "@rova/shared/workflow/graph";
import {
  createTrigger,
  registerWorkflowTrigger,
  unregisterWorkflowTrigger,
} from "@rova/shared/workflow/trigger-registry";
import { buildWorkflowFunctions } from "./functions";

function createTriggerNodeGraph(triggerConfig?: Record<string, unknown>) {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: {
          label: "Trigger",
          type: "trigger",
          config: triggerConfig,
        },
      },
    ],
    edges: [],
  });
}

function createActionOnlyGraph() {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "action-1",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "HTTP Request",
          type: "action",
        },
      },
    ],
    edges: [],
  });
}

describe("buildWorkflowFunctions", () => {
  it("creates one function per workflow with stable IDs", () => {
    const functions = buildWorkflowFunctions([
      {
        id: "workflow_123",
        name: "Order Updates",
        graph: null,
      },
      {
        id: "workflow_999",
        name: CURRENT_WORKFLOW_NAME,
        graph: null,
      },
    ]);

    expect(functions).toHaveLength(1);
    expect(functions[0].id()).toBe("workflow-workflow_123");
    expect(functions[0].name).toBe("Order Updates");
  });

  it("excludes current-workflow placeholder from functions", () => {
    const functions = buildWorkflowFunctions([
      {
        id: "workflow_only_current",
        name: CURRENT_WORKFLOW_NAME,
        graph: null,
      },
    ]);

    expect(functions).toHaveLength(0);
  });

  it("handles empty workflow list", () => {
    const functions = buildWorkflowFunctions([]);
    expect(functions).toHaveLength(0);
  });

  it("creates functions for workflows with graph data", () => {
    const graph = createTriggerNodeGraph({ triggerType: "Webhook" });

    const functions = buildWorkflowFunctions([
      {
        id: "workflow_with_graph",
        name: "Workflow With Graph",
        graph,
      },
    ]);

    expect(functions).toHaveLength(1);
    expect(functions[0].id()).toBe("workflow-workflow_with_graph");
  });
});

describe("event trigger detection in function registry", () => {
  const EVENT_TRIGGER_TYPE = "TestEventTrigger";

  registerWorkflowTrigger(
    createTrigger({
      type: EVENT_TRIGGER_TYPE,
      label: "Test Event Trigger",
      event: "app/test.event",
      schema: z.object({
        event: z.string(),
        entity: z.object({ id: z.string() }),
      }),
      // Event mode with no eventTypePath: the delivering Inngest event name
      // is the Event Type.
      correlationIdPath: "entity.id",
    })
  );

  afterAll(() => {
    unregisterWorkflowTrigger(EVENT_TRIGGER_TYPE);
  });

  it("does not include event listener functions in buildWorkflowFunctions (they are separate)", () => {
    const graph = createTriggerNodeGraph({
      triggerType: EVENT_TRIGGER_TYPE,
    });

    const functions = buildWorkflowFunctions([
      { id: "workflow_event", name: "Event Workflow", graph },
    ]);

    // buildWorkflowFunctions creates run-requested functions only
    expect(functions).toHaveLength(1);
    expect(functions[0].id()).toBe("workflow-workflow_event");
  });

  it("buildWorkflowFunctions still works with null graph", () => {
    const functions = buildWorkflowFunctions([
      { id: "workflow_null_graph", name: "Null Graph Workflow", graph: null },
    ]);

    expect(functions).toHaveLength(1);
  });

  it("buildWorkflowFunctions handles invalid graph data gracefully", () => {
    const functions = buildWorkflowFunctions([
      {
        id: "workflow_bad_graph",
        name: "Bad Graph Workflow",
        graph: { invalid: true },
      },
    ]);

    // Should still create the run-requested function (graph is used for event detection, not run function creation)
    expect(functions).toHaveLength(1);
  });

  it("buildWorkflowFunctions handles graph without trigger nodes", () => {
    const graph = createActionOnlyGraph();

    const functions = buildWorkflowFunctions([
      {
        id: "workflow_no_trigger",
        name: "No Trigger Workflow",
        graph,
      },
    ]);

    expect(functions).toHaveLength(1);
  });
});
