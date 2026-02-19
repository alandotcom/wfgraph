import { describe, expect, it } from "bun:test";
import { validateWorkflowActionConfigs } from "@/backend/lib/workflow-action-validation";
import type { WorkflowNode } from "@/shared/workflow/types";

function createTriggerNode(): WorkflowNode {
  return {
    id: "trigger_1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Trigger",
      type: "trigger",
      config: { triggerType: "Webhook" },
    },
  };
}

function createActionNode(config?: Record<string, unknown>): WorkflowNode {
  return {
    id: "action_1",
    type: "action",
    position: { x: 100, y: 100 },
    data: {
      label: "Action",
      type: "action",
      config,
    },
  };
}

describe("validateWorkflowActionConfigs", () => {
  it("accepts action nodes with a configured actionType", () => {
    const result = validateWorkflowActionConfigs([
      createTriggerNode(),
      createActionNode({ actionType: "HTTP Request" }),
    ]);

    expect(result.valid).toBe(true);
  });

  it("rejects enabled action nodes without actionType", () => {
    const result = validateWorkflowActionConfigs([
      createTriggerNode(),
      createActionNode({}),
    ]);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("has no action selected");
    }
  });

  it("ignores disabled action nodes without actionType", () => {
    const actionNode = createActionNode({});
    const result = validateWorkflowActionConfigs([
      createTriggerNode(),
      {
        ...actionNode,
        data: {
          ...actionNode.data,
          enabled: false,
        },
      },
    ]);

    expect(result.valid).toBe(true);
  });
});
