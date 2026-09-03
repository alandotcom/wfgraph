import { describe, expect, it } from "vitest";
import { layoutWorkflowNodes } from "#src/components/workflow/workflow-layout";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

describe("editor workflow layout", () => {
  it("keeps a Group frame's React Flow style aligned with its layout size", () => {
    const group: WorkflowNode = {
      id: "group_1",
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        type: "group",
        label: "Group",
        config: { entryNodeIds: ["child_1"], exitNodeIds: ["child_1"] },
      },
    };
    const child: WorkflowNode = {
      id: "child_1",
      type: "action",
      parentId: group.id,
      position: { x: 0, y: 0 },
      data: { type: "action", label: "Child" },
    };

    const result = layoutWorkflowNodes({
      nodes: [group, child],
      edges: [],
      catalog: { actions: [], events: [], integrations: [] },
    });
    const laidOutGroup = result.nodes.find((node) => node.id === group.id);

    expect(laidOutGroup?.style).toMatchObject({
      width: laidOutGroup?.width,
      height: laidOutGroup?.height,
    });
  });
});
