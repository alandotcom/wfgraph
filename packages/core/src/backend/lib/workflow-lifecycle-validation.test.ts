import { describe, expect, it } from "vitest";
import { validateWorkflowEvents } from "#src/backend/lib/workflow-lifecycle-validation";
import type { ExtensionCatalog } from "@rova/shared/extensions/catalog";
import type { LifecycleRules } from "@rova/shared/workflow/lifecycle-rules";
import type { WorkflowNode } from "@rova/shared/workflow/types";

// The vocabulary the rules are checked against, which a running app assembles
// from what the host passed `createRovaApp`.
const catalog: ExtensionCatalog = {
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
};

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

function waitNode(eventNames: string[]): WorkflowNode {
  return {
    id: "wait-1",
    type: "action",
    position: { x: 0, y: 100 },
    data: {
      label: "Wait",
      type: "action",
      config: {
        actionType: "Wait",
        waitMode: "event",
        waitFor: eventNames.map((event) => ({ event })),
      },
    },
  };
}

describe("validateWorkflowEvents - lifecycle role", () => {
  it("accepts rules naming an Event the app declares", () => {
    expect(
      validateWorkflowEvents(
        [
          lifecycleNode({
            startEvent: "app/appointment.created",
            cancelEvents: [],
            concurrency: "newest-wins",
          }),
        ],
        catalog
      )
    ).toEqual({ valid: true });
  });

  it("refuses rules naming an Event nothing declares", () => {
    const result = validateWorkflowEvents(
      [
        lifecycleNode({
          startEvent: "app/appointment.moved",
          cancelEvents: [],
          concurrency: "unlimited",
        }),
      ],
      catalog
    );

    expect(result).toMatchObject({
      valid: false,
      error: expect.stringContaining('No Event named "app/appointment.moved"'),
    });
  });

  // The panel writes the rules, so refusing a graph that predates it would lock
  // the editor out of the one screen that can add them.
  it("accepts an entry node carrying no rules", () => {
    expect(validateWorkflowEvents([lifecycleNode()], catalog)).toEqual({
      valid: true,
    });
  });

  it("accepts a graph with no entry node at all", () => {
    expect(validateWorkflowEvents([waitNode([])], catalog)).toEqual({
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

    expect(validateWorkflowEvents([node], catalog)).toEqual({
      valid: true,
    });
  });
});

describe("validateWorkflowEvents - wait subscription", () => {
  it("accepts a wait on an Event the app declares", () => {
    expect(
      validateWorkflowEvents([waitNode(["app/appointment.created"])], catalog)
    ).toEqual({ valid: true });
  });

  // A wait on a name nothing sends can only time out, so the save is where it is
  // refused rather than the run that holds until its timeout with nothing said.
  it("refuses a wait on an Event nothing declares", () => {
    expect(
      validateWorkflowEvents([waitNode(["billing/payment.settled"])], catalog)
    ).toMatchObject({
      valid: false,
      error: expect.stringContaining(
        'No Event named "billing/payment.settled"'
      ),
    });
  });

  it("asks nothing of a node that is not a Wait", () => {
    expect(validateWorkflowEvents([lifecycleNode()], catalog)).toEqual({
      valid: true,
    });
  });

  // A graph mixes both node kinds, and the walk checks each by its own kind:
  // the lifecycle role's rules and the Wait node's subscriptions, both against
  // one catalog.
  it("checks a lifecycle role and a Wait subscription in the same walk", () => {
    const result = validateWorkflowEvents(
      [
        lifecycleNode({
          startEvent: "app/appointment.created",
          cancelEvents: [],
          concurrency: "unlimited",
        }),
        waitNode(["app/appointment.created"]),
      ],
      catalog
    );

    expect(result).toEqual({ valid: true });
  });
});
