import { describe, expect, it } from "vitest";
import { inactiveCanceledBranch } from "#src/lib/inactive-canceled-branch";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@rova/shared/lifecycle/lifecycle-outlets";

function lifecycleNode(id: string, cancelEvents: string[] = []): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["app/appointment.created"],
          cancelEvents,
          concurrency: "unlimited",
        },
      },
    },
  };
}

function actionNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 100 },
    data: {
      label: id,
      type: "action",
      config: { actionType: "Wait" },
    },
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return { id, source, target, sourceHandle, type: "animated" };
}

describe("inactiveCanceledBranch", () => {
  it("marks the Canceled subtree when no Cancel Event is declared", () => {
    const nodes = [
      lifecycleNode("entry"),
      actionNode("started-wait"),
      actionNode("canceled-wait"),
      actionNode("canceled-cleanup"),
    ];
    const edges = [
      edge("e-started", "entry", "started-wait", LIFECYCLE_STARTED_HANDLE),
      edge("e-canceled", "entry", "canceled-wait", LIFECYCLE_CANCELED_HANDLE),
      edge("e-cleanup", "canceled-wait", "canceled-cleanup"),
    ];

    const inactive = inactiveCanceledBranch({ nodes, edges });

    expect([...inactive.nodeIds].sort()).toEqual([
      "canceled-cleanup",
      "canceled-wait",
    ]);
    expect([...inactive.edgeIds].sort()).toEqual(["e-canceled", "e-cleanup"]);
    expect([...inactive.outletEdgeIds]).toEqual(["e-canceled"]);
  });

  it("marks nothing when a Cancel Event is declared", () => {
    const nodes = [
      lifecycleNode("entry", ["app/appointment.canceled"]),
      actionNode("canceled-wait"),
    ];
    const edges = [
      edge("e-canceled", "entry", "canceled-wait", LIFECYCLE_CANCELED_HANDLE),
    ];

    expect(inactiveCanceledBranch({ nodes, edges })).toEqual({
      nodeIds: new Set(),
      edgeIds: new Set(),
      outletEdgeIds: new Set(),
    });
  });

  it("marks nothing when the Canceled outlet has no edges", () => {
    const nodes = [lifecycleNode("entry"), actionNode("started-wait")];
    const edges = [
      edge("e-started", "entry", "started-wait", LIFECYCLE_STARTED_HANDLE),
    ];

    expect(inactiveCanceledBranch({ nodes, edges })).toEqual({
      nodeIds: new Set(),
      edgeIds: new Set(),
      outletEdgeIds: new Set(),
    });
  });
});
