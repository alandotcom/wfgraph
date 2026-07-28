import { describe, expect, it } from "vitest";
import { validateWorkflowActionConfigs } from "@/backend/lib/workflow-action-validation";
import type { ResolveActionByType } from "@rova/shared/workflow/action-config-validation";
import type { WorkflowNode } from "@rova/shared/workflow/types";

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

const resolvePluginActionByType: ResolveActionByType = (actionType) => {
  if (actionType !== "custom/send-message") {
    return undefined;
  }

  return {
    label: "Send Message",
    configFields: [
      { key: "channel", label: "Channel", type: "text", required: true },
      { key: "message", label: "Message", type: "text", required: true },
    ],
  };
};

describe("validateWorkflowActionConfigs", () => {
  it("accepts action nodes with valid system action config", () => {
    const result = validateWorkflowActionConfigs([
      createTriggerNode(),
      createActionNode({
        actionType: "HTTP Request",
        endpoint: "https://example.com/webhook",
      }),
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

  it("rejects HTTP Request actions without an endpoint", () => {
    const result = validateWorkflowActionConfigs([
      createTriggerNode(),
      createActionNode({ actionType: "HTTP Request" }),
    ]);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("missing required fields");
      expect(result.error).toContain("URL");
    }
  });

  it("rejects Wait delay actions without timing configuration", () => {
    const result = validateWorkflowActionConfigs([
      createTriggerNode(),
      createActionNode({ actionType: "Wait", waitMode: "delay" }),
    ]);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("missing required fields");
      expect(result.error).toContain("Wait for (duration)");
    }
  });

  it("accepts Wait hook actions without delay fields", () => {
    const result = validateWorkflowActionConfigs([
      createTriggerNode(),
      createActionNode({ actionType: "Wait", waitMode: "hook" }),
    ]);

    expect(result.valid).toBe(true);
  });

  it("rejects plugin actions with missing required fields", () => {
    const result = validateWorkflowActionConfigs(
      [
        createTriggerNode(),
        createActionNode({ actionType: "custom/send-message" }),
      ],
      resolvePluginActionByType
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("missing required fields");
      expect(result.error).toContain("Channel");
      expect(result.error).toContain("Message");
    }
  });
});
