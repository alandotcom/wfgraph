import { describe, expect, it, vi } from "vitest";
import { validateWorkflowLifecycleRules } from "#src/backend/lib/workflow-lifecycle-validation";
import type { LifecycleRules } from "@rova/shared/workflow/lifecycle-rules";
import type { WorkflowNode } from "@rova/shared/workflow/types";

// The vocabulary the rules are checked against, which a running app assembles
// from what the host passed `createRovaApp`.
vi.mock("#src/backend/lib/extensions/current", () => ({
  getExtensions: () => ({
    catalog: {
      events: [
        {
          name: "app/appointment.created",
          label: "Appointment created",
          correlationPath: "appointment.id",
          payloadFields: [],
        },
      ],
      actions: [],
      integrations: [],
    },
  }),
}));

function lifecycleNode(rules?: LifecycleRules): WorkflowNode {
  return {
    id: "lifecycle-1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Start",
      type: "trigger",
      config: rules ? { lifecycleRules: rules } : {},
    },
  };
}

function waitNode(waitForEvents: unknown): WorkflowNode {
  return {
    id: "wait-1",
    type: "action",
    position: { x: 0, y: 100 },
    data: {
      label: "Wait",
      type: "action",
      config: { actionType: "Wait", waitForEvents },
    },
  };
}

describe("validateWorkflowLifecycleRules", () => {
  it("accepts rules naming an Event the app declares", () => {
    expect(
      validateWorkflowLifecycleRules([
        lifecycleNode({
          startEvents: ["app/appointment.created"],
          cancelEvents: [],
          concurrency: "newest-wins",
        }),
      ])
    ).toEqual({ valid: true });
  });

  it("refuses rules naming an Event nothing declares", () => {
    const result = validateWorkflowLifecycleRules([
      lifecycleNode({
        startEvents: ["app/appointment.moved"],
        cancelEvents: [],
        concurrency: "unlimited",
      }),
    ]);

    expect(result).toMatchObject({
      valid: false,
      error: expect.stringContaining('No Event named "app/appointment.moved"'),
    });
  });

  // The panel writes the rules, so refusing a graph that predates it would lock
  // the editor out of the one screen that can add them.
  it("accepts an entry node carrying no rules", () => {
    expect(validateWorkflowLifecycleRules([lifecycleNode()])).toEqual({
      valid: true,
    });
  });

  it("accepts a graph with no entry node at all", () => {
    expect(validateWorkflowLifecycleRules([waitNode([])])).toEqual({
      valid: true,
    });
  });

  // Rules that do not fit the shape read as no rules rather than as a refusal:
  // the graph schema is what holds them to their shape, and it decoded this node
  // before anything here saw it. A malformed bag reaching here means the config
  // came through the open custom-trigger arm, where the panel's own fields live.
  it("passes rules it cannot read, which the graph schema already refused", () => {
    const node = lifecycleNode();
    node.data.config = {
      lifecycleRules: { concurrency: "replace" },
    };

    expect(validateWorkflowLifecycleRules([node])).toEqual({ valid: true });
  });

  // A wait matches by Entity Value like a cancel does, so the graph's Wait nodes
  // are part of what the rules are checked against.
  it("holds the graph's wait Events to the Correlation Path rule", () => {
    const result = validateWorkflowLifecycleRules([
      lifecycleNode({
        startEvents: ["app/appointment.created"],
        cancelEvents: [],
        concurrency: "unlimited",
      }),
      waitNode(["app/appointment.created", "billing/payment.settled"]),
    ]);

    // `billing/payment.settled` is not in the catalog, so it is left alone; the
    // declared Event carries a path, so the graph passes.
    expect(result).toEqual({ valid: true });
  });
});
