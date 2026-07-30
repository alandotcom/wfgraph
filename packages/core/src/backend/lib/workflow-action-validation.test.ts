import { Effect, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineIntegration } from "#src/backend/lib/extensions/define-integration";
import { defineStep } from "#src/backend/lib/steps/define-step";
import {
  clearExtensions,
  configureExtensions,
} from "#src/backend/lib/extensions/current";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
import { validateWorkflowActionConfigs } from "#src/backend/lib/workflow-action-validation";
import type { ResolveActionByType } from "@rova/shared/workflow/action-config-validation";
import type { WorkflowNode } from "@rova/shared/workflow/types";

// Every reader of the surface sits inside an app, and `getExtensions` says so by
// throwing. The default resolver each function below falls back to is one of those
// readers, so a case that does not pass its own resolver needs a surface; the
// built-in four ride in on an empty assembly, which is what those cases resolve.
beforeAll(() => {
  configureExtensions(assembleExtensions({}));
});

afterAll(() => {
  clearExtensions();
});

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

  it("accepts an event Wait without delay fields", () => {
    const result = validateWorkflowActionConfigs([
      createTriggerNode(),
      createActionNode({
        actionType: "Wait",
        waitMode: "event",
        waitFor: [{ event: "appointment.created" }],
        waitTimeout: "7d",
      }),
    ]);

    expect(result.valid).toBe(true);
  });

  // A wait that parks on an Event has to name one: an empty list used to mean
  // "any Event for this entity", which the subscription index cannot hold.
  it("rejects a Wait on events that names none", () => {
    const result = validateWorkflowActionConfigs([
      createTriggerNode(),
      createActionNode({ actionType: "Wait", waitMode: "event" }),
    ]);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Wait for these events");
    }
  });

  // The default resolver is the assembled catalog, which is where an integration's
  // actions and their config fields come from once a host has passed it. A node
  // naming an action the surface does not hold has no fields to be missing, so the
  // only refusal left is the one for a node with no action at all.
  it("reads an action's required fields off the assembled catalog", () => {
    configureExtensions(
      assembleExtensions({
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
      })
    );

    const result = validateWorkflowActionConfigs([
      createTriggerNode(),
      createActionNode({ actionType: "twilio/send-sms" }),
    ]);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("missing required fields");
      expect(result.error).toContain("To");
    }

    // Back to the empty surface the rest of the file assembled.
    configureExtensions(assembleExtensions({}));
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
