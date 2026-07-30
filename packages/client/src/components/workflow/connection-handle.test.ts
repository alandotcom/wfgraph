import { describe, expect, it } from "vitest";
import { normalizeSourceHandleForConnection } from "#src/components/workflow/connection-handle";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@rova/shared/workflow/lifecycle-outlets";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/workflow/types";

function triggerNode(id = "entry"): WorkflowNode {
  return {
    id,
    type: "trigger",
    position: { x: 0, y: 0 },
    data: { label: "", type: "trigger", config: {} },
  };
}

function conditionNode(id = "cond"): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "",
      type: "action",
      config: { actionType: "Condition" },
    },
  };
}

function plainActionNode(id = "action"): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: "", type: "action", config: {} },
  };
}

describe("normalizeSourceHandleForConnection", () => {
  // The bug this guards: every edge dragged off the entry node used to be
  // renamed Started regardless of which of its two handles was actually
  // dragged, which made the Canceled outlet undraggable.
  it("keeps the Canceled handle when that is what was dragged", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes: [triggerNode()],
        edges: [],
        sourceNodeId: "entry",
        sourceHandle: LIFECYCLE_CANCELED_HANDLE,
      })
    ).toBe(LIFECYCLE_CANCELED_HANDLE);
  });

  it("keeps the Started handle when that is what was dragged", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes: [triggerNode()],
        edges: [],
        sourceNodeId: "entry",
        sourceHandle: LIFECYCLE_STARTED_HANDLE,
      })
    ).toBe(LIFECYCLE_STARTED_HANDLE);
  });

  it("falls back to Started for a connection made with no handle to read", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes: [triggerNode()],
        edges: [],
        sourceNodeId: "entry",
        sourceHandle: null,
      })
    ).toBe(LIFECYCLE_STARTED_HANDLE);
  });

  it("takes the True branch when a Condition node's outgoing edge is unlabeled", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes: [conditionNode()],
        edges: [],
        sourceNodeId: "cond",
        sourceHandle: null,
      })
    ).toBe("true");
  });

  it("takes the False branch once True is already taken", () => {
    const edges: WorkflowEdge[] = [
      {
        id: "e1",
        source: "cond",
        target: "other",
        sourceHandle: "true",
      },
    ];

    expect(
      normalizeSourceHandleForConnection({
        nodes: [conditionNode()],
        edges,
        sourceNodeId: "cond",
        sourceHandle: null,
      })
    ).toBe("false");
  });

  it("passes an ordinary action node's handle through unchanged", () => {
    expect(
      normalizeSourceHandleForConnection({
        nodes: [plainActionNode()],
        edges: [],
        sourceNodeId: "action",
        sourceHandle: "out",
      })
    ).toBe("out");
  });
});
