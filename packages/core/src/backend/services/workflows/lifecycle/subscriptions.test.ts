import { describe, expect, it } from "vitest";
import type { LifecycleRules } from "@rova/shared/lifecycle/lifecycle-rules";
import type { WorkflowNode } from "@rova/shared/graph/types";
import { deriveEventSubscriptions } from "#src/backend/services/workflows/lifecycle/subscriptions";

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

function waitNode(input: { id: string; waitFor: string[] }): WorkflowNode {
  return {
    id: input.id,
    type: "action",
    position: { x: 0, y: 100 },
    data: {
      label: "Wait",
      type: "action",
      config: {
        actionType: "Wait",
        waitMode: "event",
        waitFor: input.waitFor.map((event) => ({ event })),
      },
    },
  };
}

describe("deriveEventSubscriptions", () => {
  it("names a role per Event the rules list", () => {
    const rows = deriveEventSubscriptions({
      workflowId: "wf_1",
      nodes: [
        lifecycleNode({
          startEvent: "app/appointment.created",
          cancelEvents: ["app/appointment.canceled"],
          concurrency: "newest-wins",
        }),
      ],
    });

    expect(rows).toEqual([
      {
        workflowId: "wf_1",
        eventName: "app/appointment.created",
        role: "start",
        correlationPath: null,
      },
      {
        workflowId: "wf_1",
        eventName: "app/appointment.canceled",
        role: "cancel",
        correlationPath: null,
      },
    ]);
  });

  // A Wait node subscribes on its own account: an Event that starts no workflow
  // still has to reach a run parked on it.
  it("names the Events a Wait node parks on", () => {
    const rows = deriveEventSubscriptions({
      workflowId: "wf_1",
      nodes: [
        lifecycleNode({
          startEvent: "app/appointment.created",
          cancelEvents: [],
          concurrency: "unlimited",
        }),
        waitNode({ id: "wait-1", waitFor: ["billing/payment.settled"] }),
      ],
    });

    expect(rows).toContainEqual({
      workflowId: "wf_1",
      eventName: "billing/payment.settled",
      role: "wait",
      correlationPath: null,
    });
  });

  // The path travels on the row so a delivery can find a parked run's entity
  // without reading the graph the rules sit in. The overrides are on the entry
  // node and a wait row comes from a node elsewhere, so the wait row carries it
  // too -- whatever order the nodes arrive in.
  it("carries the builder's Correlation Path override onto every role", () => {
    const rows = deriveEventSubscriptions({
      workflowId: "wf_1",
      nodes: [
        waitNode({ id: "wait-1", waitFor: ["ops/nightly.swept"] }),
        lifecycleNode({
          startEvent: "app/appointment.created",
          cancelEvents: [],
          concurrency: "unlimited",
          correlationPaths: {
            "app/appointment.created": "appointment.id",
            "ops/nightly.swept": "sweep.id",
          },
        }),
      ],
    });

    expect(rows).toEqual([
      {
        workflowId: "wf_1",
        eventName: "ops/nightly.swept",
        role: "wait",
        correlationPath: "sweep.id",
      },
      {
        workflowId: "wf_1",
        eventName: "app/appointment.created",
        role: "start",
        correlationPath: "appointment.id",
      },
    ]);
  });

  // The override outranks the Event's own declaration at delivery, so a Cancel
  // Event whose author named the wrong field for this workflow is corrected here
  // and the row is what carries the correction.
  it("carries a Cancel Event's override onto its row", () => {
    const rows = deriveEventSubscriptions({
      workflowId: "wf_1",
      nodes: [
        lifecycleNode({
          startEvent: "app/appointment.created",
          cancelEvents: ["app/appointment.canceled"],
          concurrency: "unlimited",
          correlationPaths: { "app/appointment.canceled": "patient.id" },
        }),
      ],
    });

    expect(rows).toContainEqual({
      workflowId: "wf_1",
      eventName: "app/appointment.canceled",
      role: "cancel",
      correlationPath: "patient.id",
    });
  });

  it("keeps one row per Event and role however many nodes ask", () => {
    const rows = deriveEventSubscriptions({
      workflowId: "wf_1",
      nodes: [
        lifecycleNode({
          startEvent: "app/appointment.created",
          cancelEvents: [],
          concurrency: "unlimited",
        }),
        waitNode({ id: "wait-1", waitFor: ["billing/payment.settled"] }),
        waitNode({ id: "wait-2", waitFor: ["billing/payment.settled"] }),
      ],
    });

    expect(rows).toHaveLength(2);
  });

  // An Event holding a role and a wait in one workflow gets both rows: they are
  // separate subscriptions and the fan-out visits the workflow once.
  it("keeps a start and a wait on the same Event apart", () => {
    const rows = deriveEventSubscriptions({
      workflowId: "wf_1",
      nodes: [
        lifecycleNode({
          startEvent: "app/appointment.created",
          cancelEvents: [],
          concurrency: "unlimited",
        }),
        waitNode({ id: "wait-1", waitFor: ["app/appointment.created"] }),
      ],
    });

    expect(rows.map((row) => row.role)).toEqual(["start", "wait"]);
  });

  it("answers with nothing for a graph that names no Event", () => {
    expect(
      deriveEventSubscriptions({
        workflowId: "wf_1",
        nodes: [lifecycleNode(), waitNode({ id: "wait-1", waitFor: [] })],
      })
    ).toEqual([]);
  });
});
