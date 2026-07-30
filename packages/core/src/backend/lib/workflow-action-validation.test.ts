import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { defineIntegration } from "#src/backend/lib/extensions/define-integration";
import { defineStep } from "#src/backend/lib/steps/define-step";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
import { validateWorkflowActionConfigs } from "#src/backend/lib/workflow-action-validation";
import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
} from "@rova/shared/extensions/catalog";
import type { WorkflowNode } from "@rova/shared/workflow/types";

// An action's required fields come from the catalog a save reads, and the
// built-in two, Condition and Wait, ride in on an empty assembly.
const builtInCatalog = assembleExtensions({}).catalog;

function createTriggerNode(): WorkflowNode {
  return {
    id: "trigger_1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Trigger",
      type: "trigger",
      config: {},
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

const pluginCatalog: ExtensionCatalog = {
  ...emptyExtensionCatalog,
  actions: [
    {
      id: "custom/send-message",
      label: "Send Message",
      description: "Sends a message",
      category: "Custom",
      configFields: [
        { key: "channel", label: "Channel", type: "text", required: true },
        { key: "message", label: "Message", type: "text", required: true },
      ],
      outputFields: [],
    },
  ],
};

describe("validateWorkflowActionConfigs", () => {
  it("accepts action nodes with valid system action config", () => {
    const result = validateWorkflowActionConfigs(
      [
        createTriggerNode(),
        createActionNode({
          actionType: "Condition",
          condition: "true",
        }),
      ],
      builtInCatalog
    );

    expect(result.valid).toBe(true);
  });

  it("rejects enabled action nodes without actionType", () => {
    const result = validateWorkflowActionConfigs(
      [createTriggerNode(), createActionNode({})],
      builtInCatalog
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("has no action selected");
    }
  });

  it("ignores disabled action nodes without actionType", () => {
    const actionNode = createActionNode({});
    const result = validateWorkflowActionConfigs(
      [
        createTriggerNode(),
        {
          ...actionNode,
          data: {
            ...actionNode.data,
            enabled: false,
          },
        },
      ],
      builtInCatalog
    );

    expect(result.valid).toBe(true);
  });

  it("rejects Condition actions without a condition", () => {
    const result = validateWorkflowActionConfigs(
      [createTriggerNode(), createActionNode({ actionType: "Condition" })],
      builtInCatalog
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("missing required fields");
      expect(result.error).toContain("Condition");
    }
  });

  it("rejects Wait delay actions without timing configuration", () => {
    const result = validateWorkflowActionConfigs(
      [
        createTriggerNode(),
        createActionNode({ actionType: "Wait", waitMode: "delay" }),
      ],
      builtInCatalog
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("missing required fields");
      expect(result.error).toContain("Wait for (duration)");
    }
  });

  it("accepts an event Wait without delay fields", () => {
    const result = validateWorkflowActionConfigs(
      [
        createTriggerNode(),
        createActionNode({
          actionType: "Wait",
          waitMode: "event",
          waitFor: [{ event: "appointment.created" }],
          waitTimeout: "7d",
        }),
      ],
      builtInCatalog
    );

    expect(result.valid).toBe(true);
  });

  // A wait that parks on an Event has to name one: an empty list used to mean
  // "any Event for this entity", which the subscription index cannot hold.
  it("rejects a Wait on events that names none", () => {
    const result = validateWorkflowActionConfigs(
      [
        createTriggerNode(),
        createActionNode({ actionType: "Wait", waitMode: "event" }),
      ],
      builtInCatalog
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Wait for these events");
    }
  });

  // An integration's actions and their config fields reach the check through the
  // assembled catalog. A node naming an action the surface does not hold has no
  // fields to be missing, so the only refusal left is the one for a node with no
  // action at all.
  it("reads an action's required fields off the assembled catalog", () => {
    const twilioCatalog = assembleExtensions({
      integrations: [
        defineIntegration({
          type: "twilio",
          label: "Twilio",
          description: "Send SMS messages",
          credentials: [],
          actions: {
            "send-sms": defineStep({
              label: "Send SMS",
              description: "Sends a message",
              category: "Twilio",
              input: Schema.Struct({ smsTo: Schema.String }),
              output: Schema.Struct({
                sid: Schema.String.annotate({ description: "Message SID" }),
              }),
              configFields: [
                {
                  key: "smsTo",
                  label: "To",
                  type: "template-input",
                  required: true,
                },
              ],
              handler: Effect.fn(function* () {
                return yield* Effect.succeed({ sid: "SM1" });
              }),
            }),
          },
        }),
      ],
    }).catalog;

    const result = validateWorkflowActionConfigs(
      [
        createTriggerNode(),
        createActionNode({ actionType: "twilio/send-sms" }),
      ],
      twilioCatalog
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("missing required fields");
      expect(result.error).toContain("To");
    }
  });

  it("rejects plugin actions with missing required fields", () => {
    const result = validateWorkflowActionConfigs(
      [
        createTriggerNode(),
        createActionNode({ actionType: "custom/send-message" }),
      ],
      pluginCatalog
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("missing required fields");
      expect(result.error).toContain("Channel");
      expect(result.error).toContain("Message");
    }
  });
});
