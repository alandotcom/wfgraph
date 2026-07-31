import { describe, expect, it } from "vitest";
import {
  getMissingRequiredFieldsForNodes,
  getNodeMissingRequiredFields,
  type ResolveActionByType,
} from "./action-config-validation";
import {
  createDefaultConditionModel,
  serializeConditionModel,
} from "#src/conditions/conditions";
import type { WorkflowNode } from "#src/graph/types";

function createLifecycleNode(): WorkflowNode {
  return {
    id: "lifecycle_1",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: {},
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

  it("accepts an event wait naming an Event and a timeout", () => {
    const result = getNodeMissingRequiredFields({
      node: createActionNode({
        actionType: "Wait",
        waitMode: "event",
        waitFor: [{ event: "appointment.created" }],
        waitTimeout: "7d",
      }),
      resolveActionByType,
    });

    expect(result).toBeNull();
  });

  // A wait with no end holds a run, and a place in the run list, until somebody
  // notices. The editor writes a default the moment the mode is chosen, so a
  // blank one is a builder who cleared it.
  it("refuses an event wait with no timeout", () => {
    const result = getNodeMissingRequiredFields({
      node: createActionNode({
        actionType: "Wait",
        waitMode: "event",
        waitFor: [{ event: "appointment.created" }],
      }),
      resolveActionByType,
    });

    expect(result?.missingFields).toEqual([
      { fieldKey: "waitTimeout", fieldLabel: "Stop waiting after" },
    ]);
  });

  it("refuses an event wait naming no Event", () => {
    const result = getNodeMissingRequiredFields({
      node: createActionNode({
        actionType: "Wait",
        waitMode: "event",
        waitFor: [],
        waitTimeout: "7d",
      }),
      resolveActionByType,
    });

    expect(result?.missingFields).toEqual([
      { fieldKey: "waitFor", fieldLabel: "Wait for these events" },
    ]);
  });

  // The save rule lets a half-typed match through so an autosave is not refused
  // mid-edit, which makes this the one place a match comparing against nothing
  // is caught. Left alone it parks the run until its timeout and says nothing.
  it("refuses an event wait whose match has an untyped operand", () => {
    const seeded = serializeConditionModel(
      createDefaultConditionModel({
        path: "appointment.id",
        label: "appointment.id",
        type: "string",
      })
    );

    const result = getNodeMissingRequiredFields({
      node: createActionNode({
        actionType: "Wait",
        waitMode: "event",
        waitFor: [{ event: "appointment.created", match: seeded }],
        waitTimeout: "7d",
      }),
      resolveActionByType,
    });

    expect(result?.missingFields).toEqual([
      {
        fieldKey: "waitFor",
        fieldLabel: 'Match value for "appointment.created"',
      },
    ]);
  });

  it("accepts an event wait whose match compares against a value", () => {
    const model = createDefaultConditionModel({
      path: "appointment.id",
      label: "appointment.id",
      type: "string",
    });
    model.groups[0].conditions[0] = {
      ...model.groups[0].conditions[0],
      fieldType: "string",
      operator: "equals",
      value: "appt_1",
    };

    const result = getNodeMissingRequiredFields({
      node: createActionNode({
        actionType: "Wait",
        waitMode: "event",
        waitFor: [
          {
            event: "appointment.created",
            match: serializeConditionModel(model),
          },
        ],
        waitTimeout: "7d",
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
        waitFor: [{ event: "appointment.created" }],
        waitTimeout: "7d",
        waitDuration: "",
        waitUntil: "",
      }),
      resolveActionByType,
    });

    expect(result).toBeNull();
  });

  it("requires a condition expression", () => {
    const result = getNodeMissingRequiredFields({
      node: createActionNode({ actionType: "Condition" }),
      resolveActionByType,
    });

    expect(result?.missingFields).toEqual([
      { fieldKey: "condition", fieldLabel: "Condition" },
    ]);
  });

  it("ignores disabled action nodes", () => {
    const result = getNodeMissingRequiredFields({
      node: createActionNode(
        {
          actionType: "Condition",
        },
        {
          data: {
            label: "Action Step",
            type: "action",
            enabled: false,
            config: { actionType: "Condition" },
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
        createLifecycleNode(),
        createActionNode({ actionType: "Condition" }),
        // A wait mode that parks on an Event has to name one, so this fixture
        // names one: what the case is about is the Lifecycle Node being left out.
        createActionNode(
          {
            actionType: "Wait",
            waitMode: "event",
            waitFor: [{ event: "appointment.created" }],
            waitTimeout: "7d",
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
            fieldKey: "condition",
            fieldLabel: "Condition",
          },
        ],
      },
    ]);
  });
});
