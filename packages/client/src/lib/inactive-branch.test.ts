import { describe, expect, it } from "vitest";
import { inactiveBranch } from "#src/lib/inactive-branch";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

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

function actionNode(id: string, enabled = true): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 100 },
    data: {
      label: id,
      type: "action",
      config: { actionType: "Wait" },
      ...(enabled ? {} : { enabled: false }),
    },
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  // React Flow declares `sourceHandle` as a plain optional key, so an edge
  // leaving a node's only handle carries no key at all.
  return omitUndefined({ id, source, target, sourceHandle });
}

describe("inactiveBranch", () => {
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

    const inactive = inactiveBranch({ nodes, edges });

    expect([...inactive.nodeIds].sort()).toEqual([
      "canceled-cleanup",
      "canceled-wait",
    ]);
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

    expect(inactiveBranch({ nodes, edges })).toEqual({
      nodeIds: new Set(),
      outletEdgeIds: new Set(),
    });
  });

  it("marks nothing when the Canceled outlet has no edges", () => {
    const nodes = [lifecycleNode("entry"), actionNode("started-wait")];
    const edges = [
      edge("e-started", "entry", "started-wait", LIFECYCLE_STARTED_HANDLE),
    ];

    expect(inactiveBranch({ nodes, edges })).toEqual({
      nodeIds: new Set(),
      outletEdgeIds: new Set(),
    });
  });

  // The disabled node draws its own face; what a person cannot read off the
  // canvas today is that the branch ends there.
  it("marks everything below a disabled step, and not the step itself", () => {
    const nodes = [
      lifecycleNode("entry"),
      actionNode("wait", false),
      actionNode("below"),
      actionNode("further"),
    ];
    const edges = [
      edge("e-started", "entry", "wait", LIFECYCLE_STARTED_HANDLE),
      edge("e-below", "wait", "below"),
      edge("e-further", "below", "further"),
    ];

    const inactive = inactiveBranch({ nodes, edges });

    expect([...inactive.nodeIds].sort()).toEqual(["below", "further"]);
    expect(inactive.nodeIds.has("wait")).toBe(false);
  });

  // A node is ready only when every predecessor released it, so an arm that
  // never arrives holds the join for the life of the run.
  it("marks a join one of whose arms is disabled", () => {
    const nodes = [
      lifecycleNode("entry"),
      actionNode("live-arm"),
      actionNode("dead-arm", false),
      actionNode("join"),
    ];
    const edges = [
      edge("e-live", "entry", "live-arm", LIFECYCLE_STARTED_HANDLE),
      edge("e-dead", "entry", "dead-arm", LIFECYCLE_STARTED_HANDLE),
      edge("e-join-live", "live-arm", "join"),
      edge("e-join-dead", "dead-arm", "join"),
    ];

    expect([...inactiveBranch({ nodes, edges }).nodeIds]).toEqual(["join"]);
  });

  // The painted edge into a Group names the frame, not the member the store
  // edge names, so the frame has to answer for members nothing can reach.
  it("names the frame of a Group no run can enter", () => {
    const nodes = [
      lifecycleNode("entry"),
      actionNode("wait", false),
      { ...actionNode("lookup"), parentId: "frame" },
      { ...actionNode("condition"), parentId: "frame" },
      {
        id: "frame",
        position: { x: 0, y: 0 },
        data: { label: "", type: "group" },
      } as WorkflowNode,
    ];
    const edges = [
      edge("e-started", "entry", "wait", LIFECYCLE_STARTED_HANDLE),
      edge("e-in", "wait", "lookup"),
      edge("e-interior", "lookup", "condition"),
    ];

    expect([...inactiveBranch({ nodes, edges }).nodeIds].sort()).toEqual([
      "condition",
      "frame",
      "lookup",
    ]);
  });

  // A member the run does arrive at and skip. The frame stays out of the set,
  // so the edge into it keeps drawing live and the frame wears its own face.
  it("leaves the frame alone when its members are only disabled", () => {
    const nodes = [
      lifecycleNode("entry"),
      { ...actionNode("lookup", false), parentId: "frame" },
      { ...actionNode("condition", false), parentId: "frame" },
      {
        id: "frame",
        position: { x: 0, y: 0 },
        data: { label: "", type: "group" },
      } as WorkflowNode,
      actionNode("after"),
    ];
    const edges = [
      edge("e-started", "entry", "lookup", LIFECYCLE_STARTED_HANDLE),
      edge("e-interior", "lookup", "condition"),
      edge("e-after", "condition", "after", "true"),
    ];

    const { nodeIds } = inactiveBranch({ nodes, edges });
    expect(nodeIds.has("frame")).toBe(false);
    expect([...nodeIds].sort()).toEqual(["after", "condition"]);
  });

  it("walks out of a Group, since a store edge names the member", () => {
    const nodes = [
      lifecycleNode("entry"),
      { ...actionNode("condition", false), parentId: "frame" },
      actionNode("after"),
    ];
    const edges = [
      edge("e-started", "entry", "condition", LIFECYCLE_STARTED_HANDLE),
      edge("e-after", "condition", "after", "true"),
    ];

    expect([...inactiveBranch({ nodes, edges }).nodeIds]).toEqual(["after"]);
  });
});
