import { describe, expect, it } from "vitest";
import {
  getMissingRequiredFieldsForNodes,
  getNodeMissingRequiredFields,
  type ResolveActionByType,
} from "./action-config-validation";
import type { WorkflowNode } from "./types";

function createTriggerNode(): WorkflowNode {
  return {
    id: "trigger_1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Trigger",
      type: "trigger",
      config: {
        triggerType: "Webhook",
      },
    },
  };
}

function createActionNode(
  config: Record<string, unknown>,
  overrides?: Partial<WorkflowNode>
): WorkflowNode {
  return {
    id: "action_1",
    type: "action",
    position: { x: 100, y: 100 },
    data: {
      label: "Action Step",
      type: "action",
      config,
    },
    ...overrides,
  };
}

const resolveActionByType: ResolveActionByType = (actionType) => {
  if (actionType !== "custom/send") {
    return undefined;
  }

  return {
    label: "Send Message",
    configFields: [
      {
        type: "group",
        fields: [
          { key: "channel", label: "Channel", type: "text", required: true },
          {
            key: "message",
            label: "Message",
            type: "text",
            required: true,
            showWhen: { field: "deliveryMode", equals: "direct" },
          },
        ],
      },
    ],
  };
};

describe("getNodeMissingRequiredFields", () => {
  it("returns action selection error for enabled action nodes without actionType", () => {
    const result = getNodeMissingRequiredFields({
      node: createActionNode({ actionType: "   " }),
      resolveActionByType,
    });

    expect(result).toEqual({
      nodeId: "action_1",
      nodeLabel: "Action Step",
      missingFields: [
        {
          fieldKey: "actionType",
          fieldLabel: "Action",
        },
      ],
    });
  });

  it("uses resolved action label when node label is blank", () => {
    const node = createActionNode(
      {
        actionType: "custom/send",
      },
      {
        data: {
          label: "   ",
          type: "action",
          config: {
            actionType: "custom/send",
          },
        },
      }
    );

    const result = getNodeMissingRequiredFields({
      node,
      resolveActionByType,
    });

    expect(result?.nodeLabel).toBe("Send Message");
  });

  it("enforces wait-until when delay timing mode is until", () => {
    const result = getNodeMissingRequiredFields({
      node: createActionNode({
        actionType: "Wait",
        waitMode: "delay",
        waitDelayTimingMode: "until",
      }),
      resolveActionByType,
    });

    expect(result?.missingFields).toEqual([
      {
        fieldKey: "waitUntil",
        fieldLabel: "Wait until this date/time",
      },
    ]);
  });

  it("accepts wait nodes configured with waitUntil even without timing mode", () => {
    const result = getNodeMissingRequiredFields({
      node: createActionNode({
        actionType: "Wait",
        waitMode: "delay",
        waitUntil: "2026-02-11T10:00:00Z",
      }),
      resolveActionByType,
    });

    expect(result).toBeNull();
  });

  it("accepts database query action using legacy query key", () => {
    const result = getNodeMissingRequiredFields({
      node: createActionNode({
        actionType: "Database Query",
        query: "select 1",
      }),
      resolveActionByType,
    });

    expect(result).toBeNull();
  });

  it("respects showWhen on required plugin fields", () => {
    const hiddenRequiredField = getNodeMissingRequiredFields({
      node: createActionNode({
        actionType: "custom/send",
        channel: "ops-alerts",
        deliveryMode: "broadcast",
      }),
      resolveActionByType,
    });

    expect(hiddenRequiredField).toBeNull();

    const visibleRequiredField = getNodeMissingRequiredFields({
      node: createActionNode({
        actionType: "custom/send",
        channel: "ops-alerts",
        deliveryMode: "direct",
      }),
      resolveActionByType,
    });

    expect(visibleRequiredField?.missingFields).toEqual([
      {
        fieldKey: "message",
        fieldLabel: "Message",
      },
    ]);
  });

  it("accepts wait nodes with event mode (no required fields)", () => {
    const result = getNodeMissingRequiredFields({
      node: createActionNode({
        actionType: "Wait",
        waitMode: "event",
        waitForEvents: ["appointment.created"],
      }),
      resolveActionByType,
    });

    expect(result).toBeNull();
  });

  it("does not require delay fields when waitMode is event", () => {
    const result = getNodeMissingRequiredFields({
      node: createActionNode({
        actionType: "Wait",
        waitMode: "event",
        waitForEvents: ["appointment.created"],
        waitDuration: "",
        waitUntil: "",
      }),
      resolveActionByType,
    });

    expect(result).toBeNull();
  });

  it("ignores disabled action nodes", () => {
    const result = getNodeMissingRequiredFields({
      node: createActionNode(
        {
          actionType: "HTTP Request",
        },
        {
          data: {
            label: "Action Step",
            type: "action",
            enabled: false,
            config: { actionType: "HTTP Request" },
          },
        }
      ),
      resolveActionByType,
    });

    expect(result).toBeNull();
  });
});

describe("getMissingRequiredFieldsForNodes", () => {
  it("returns missing required fields only for actionable nodes", () => {
    const result = getMissingRequiredFieldsForNodes({
      nodes: [
        createTriggerNode(),
        createActionNode({ actionType: "HTTP Request" }),
        // A wait mode that parks on an Event has to name one, so this fixture
        // names one: what the case is about is the trigger node being left out.
        createActionNode(
          {
            actionType: "Wait",
            waitMode: "hook",
            waitForEvents: ["appointment.created"],
          },
          { id: "action_2" }
        ),
      ],
      resolveActionByType,
    });

    expect(result).toEqual([
      {
        nodeId: "action_1",
        nodeLabel: "Action Step",
        missingFields: [
          {
            fieldKey: "endpoint",
            fieldLabel: "URL",
          },
        ],
      },
    ]);
  });
});
