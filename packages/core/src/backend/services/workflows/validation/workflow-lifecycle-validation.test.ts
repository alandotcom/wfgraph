import { describe, expect, it } from "vitest";
import { errorOf } from "#src/backend/services/workflows/validation/validation-test-support";
import {
  validateEventSplitOutlets,
  validateWorkflowEvents,
} from "#src/backend/services/workflows/validation/workflow-lifecycle-validation";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";

// The vocabulary the rules are checked against, which a running app assembles
// from what the host passed `createWfGraphApp`.
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
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Start",
      type: "lifecycle",
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
            startEvents: ["app/appointment.created"],
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
          startEvents: ["app/appointment.moved"],
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
  // the graph schema is what holds them to their shape in production, decoding
  // a stored node before this validator ever sees it. This test calls the
  // validator directly with a bag the schema would have refused, so it has to
  // answer without that guarantee too.
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
          startEvents: ["app/appointment.created"],
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

describe("validateEventSplitOutlets", () => {
  const rules: LifecycleRules = {
    startEvents: ["app/appointment.created"],
    cancelEvents: [],
    concurrency: "unlimited",
  };

  const splitNode: WorkflowNode = {
    id: "split-1",
    type: "action",
    position: { x: 0, y: 100 },
    data: {
      label: "Split on Event",
      type: "action",
      config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
    },
  };

  const targetNode: WorkflowNode = {
    id: "action-1",
    type: "action",
    position: { x: 0, y: 200 },
    data: { label: "Send", type: "action", config: { actionType: "Send" } },
  };

  const nodes = [lifecycleNode(rules), splitNode, targetNode];
  const entryEdge: WorkflowEdge = {
    id: "e1",
    source: "lifecycle-1",
    sourceHandle: LIFECYCLE_STARTED_HANDLE,
    target: "split-1",
  };

  it("accepts an outlet naming an Event that reaches the split", () => {
    expect(
      validateEventSplitOutlets(
        nodes,
        [
          entryEdge,
          {
            id: "e2",
            source: "split-1",
            sourceHandle: eventSplitOutlet("app/appointment.created"),
            target: "action-1",
          },
        ],
        catalog
      )
    ).toEqual({ valid: true });
  });

  it("refuses an outlet naming an Event that cannot reach the split", () => {
    // The Events that reach the split decide which outlets a run can take, so
    // an outlet for another is a branch no run travels.
    const result = validateEventSplitOutlets(
      nodes,
      [
        entryEdge,
        {
          id: "e2",
          source: "split-1",
          sourceHandle: eventSplitOutlet("app/appointment.canceled"),
          target: "action-1",
        },
      ],
      catalog
    );

    expect(result.valid).toBe(false);
    expect(errorOf(result)).toContain("app/appointment.canceled");
  });

  it("refuses an edge leaving the split by no outlet at all", () => {
    const result = validateEventSplitOutlets(
      nodes,
      [entryEdge, { id: "e2", source: "split-1", target: "action-1" }],
      catalog
    );

    expect(result.valid).toBe(false);
  });

  it("accepts an outlet naming an Event a Wait above the split parks on", () => {
    const waitCatalog: ExtensionCatalog = {
      events: [
        ...catalog.events,
        {
          name: "billing/payment.settled",
          label: "Payment settled",
          payloadFields: [],
        },
      ],
      actions: [],
      integrations: [],
    };
    const wait: WorkflowNode = waitNode(["billing/payment.settled"]);
    const splitAfterWait: WorkflowNode = {
      ...splitNode,
      id: "split-after-wait",
    };
    const target: WorkflowNode = { ...targetNode, id: "after-split" };

    expect(
      validateEventSplitOutlets(
        [lifecycleNode(rules), wait, splitAfterWait, target],
        [
          {
            id: "e1",
            source: "lifecycle-1",
            sourceHandle: LIFECYCLE_STARTED_HANDLE,
            target: "wait-1",
          },
          { id: "e2", source: "wait-1", target: "split-after-wait" },
          {
            id: "e3",
            source: "split-after-wait",
            sourceHandle: eventSplitOutlet("billing/payment.settled"),
            target: "after-split",
          },
        ],
        waitCatalog
      )
    ).toEqual({ valid: true });
  });
});
