import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowNodeBounds } from "./use-focus-workflow-node";

describe("workflowNodeBounds", () => {
  it("uses a Group frame's position for a child node's focus bounds", () => {
    const group: WorkflowNode = {
      id: "group",
      type: "group",
      position: { x: 400, y: 120 },
      width: 420,
      height: 220,
      data: { label: "Customer updates", type: "group" },
    };
    const child: WorkflowNode = {
      id: "notify",
      parentId: group.id,
      type: "action",
      position: { x: 24, y: 48 },
      initialWidth: 188,
      initialHeight: 56,
      data: { label: "Notify customer", type: "action" },
    };

    expect(workflowNodeBounds([group, child], child)).toEqual({
      x: 424,
      y: 168,
      width: 188,
      height: 56,
    });
  });
});
