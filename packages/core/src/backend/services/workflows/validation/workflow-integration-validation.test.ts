import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import {
  extractRequiredIntegrationIds,
  validateWorkflowIntegrations,
} from "#src/backend/services/workflows/validation/workflow-integration-validation";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";

// Which integration an action needs is the catalog's answer, and the built-in
// two ride in on an empty assembly.
const builtInCatalog = assembleExtensions({}).catalog;

/** The built-ins beside two host actions, each naming a connection of its own. */
const slackCatalog: ExtensionCatalog = {
  ...builtInCatalog,
  actions: [
    ...builtInCatalog.actions,
    {
      id: "custom/send-message",
      label: "Send Message",
      description: "Sends a message",
      category: "Custom",
      integration: "slack",
      configFields: [],
      outputFields: [],
    },
    {
      id: "custom/send-sms",
      label: "Send SMS",
      description: "Sends an SMS",
      category: "Custom",
      integration: "twilio",
      configFields: [],
      outputFields: [],
    },
  ],
};

function createActionNode(config: Record<string, unknown>): WorkflowNode {
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

/** An integration whose one action names it, which is what the default resolver reads. */
const twilio = defineIntegration({
  type: "twilio",
  label: "Twilio",
  description: "Sends messages",
  credentials: {},
  actions: {
    "send-sms": {
      label: "Send SMS",
      description: "Sends a message",
      input: Schema.Struct({ smsTo: Schema.String }),
      output: Schema.Struct({
        sid: Schema.String.annotate({ description: "Message SID" }),
      }),
      configFields: [
        { key: "smsTo", label: "To", type: "template-input", required: true },
      ],
      handler: Effect.fn(function* () {
        return yield* Effect.succeed({ sid: "SM1" });
      }),
    },
  },
});

/** Slack's actions beside one Event Slack owns and one the host declares. */
const eventCatalog: ExtensionCatalog = {
  ...slackCatalog,
  events: [
    {
      name: "slack/message.posted",
      label: "Message posted",
      integration: "slack",
      payloadFields: [],
    },
    {
      name: "app/appointment.created",
      label: "Appointment created",
      payloadFields: [],
    },
  ],
};

function createLifecycleNode(
  rules: Record<string, unknown>,
  id = "lifecycle_1"
): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: { lifecycleRules: rules },
    },
  };
}

function createWaitNode(
  waitFor: readonly Record<string, unknown>[],
  id = "wait_1"
): WorkflowNode {
  return {
    ...createActionNode({
      actionType: "Wait",
      waitMode: "event",
      waitFor,
      waitTimeout: "7d",
    }),
    id,
  };
}

describe("extractRequiredIntegrationIds", () => {
  it("includes integration IDs for actions that require integrations", () => {
    const ids = extractRequiredIntegrationIds(
      [
        createActionNode({
          actionType: "custom/send-sms",
          integrationId: "sms_1",
        }),
        {
          ...createActionNode({
            actionType: "custom/send-message",
            integrationId: "slack_1",
          }),
          id: "action_2",
        },
      ],
      slackCatalog
    );

    expect(ids).toEqual(["sms_1", "slack_1"]);
  });

  it("ignores integration IDs on actions that do not require integrations", () => {
    const ids = extractRequiredIntegrationIds(
      [
        createActionNode({
          actionType: "Condition",
          integrationId: "stale_integration_id",
        }),
        {
          ...createActionNode({
            actionType: "Wait",
            integrationId: "another_stale_id",
          }),
          id: "action_2",
        },
      ],
      builtInCatalog
    );

    expect(ids).toEqual([]);
  });

  it("ignores disabled nodes and empty values", () => {
    const disabledNode = createActionNode({
      actionType: "custom/send-message",
      integrationId: "slack_1",
    });

    const ids = extractRequiredIntegrationIds(
      [
        {
          ...disabledNode,
          data: {
            ...disabledNode.data,
            enabled: false,
          },
        },
        createActionNode({
          actionType: "custom/send-message",
          integrationId: "   ",
        }),
        createActionNode({
          actionType: "custom/send-message",
        }),
      ],
      slackCatalog
    );

    expect(ids).toEqual([]);
  });
});

describe("validateWorkflowIntegrations", () => {
  it("deduplicates integration ids before the one read it makes", async () => {
    const getIntegrationTypesByIds = vi.fn(() =>
      Effect.succeed({ shared_integration: "slack" })
    );

    const result = await Effect.runPromise(
      validateWorkflowIntegrations(
        [
          createActionNode({
            actionType: "custom/send-message",
            integrationId: "shared_integration",
          }),
          {
            ...createActionNode({
              actionType: "custom/send-message",
              integrationId: "shared_integration",
            }),
            id: "action_2",
          },
        ],
        slackCatalog,
        getIntegrationTypesByIds
      )
    );

    expect(result).toEqual({ valid: true });
    expect(getIntegrationTypesByIds).toHaveBeenCalledTimes(1);
    expect(getIntegrationTypesByIds).toHaveBeenCalledWith([
      "shared_integration",
    ]);
  });

  // An id absent from the type map is an id no row carries, which is why one read
  // answers both questions the graph asks.
  it("names an integration nothing carries", async () => {
    const result = await Effect.runPromise(
      validateWorkflowIntegrations(
        [
          createActionNode({
            actionType: "custom/send-sms",
            integrationId: "sms_1",
          }),
          {
            ...createActionNode({
              actionType: "custom/send-message",
              integrationId: "slack_1",
            }),
            id: "action_2",
          },
        ],
        slackCatalog,
        () => Effect.succeed({ slack_1: "slack" })
      )
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_ids",
      invalidIds: ["sms_1"],
    });
  });

  // The catalog is what a save reads. An action it holds carries the integration
  // its nodes must name, and a row of a different type is refused by id.
  it("reads an action's required integration off the assembled catalog", async () => {
    const result = await Effect.runPromise(
      validateWorkflowIntegrations(
        [
          createActionNode({
            actionType: "twilio/send-sms",
            integrationId: "slack_1",
          }),
        ],
        assembleExtensions({ integrations: [twilio] }).catalog,
        () => Effect.succeed({ slack_1: "slack" })
      )
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_ids",
      invalidIds: ["slack_1"],
    });
  });

  it("rejects integrations with mismatched types", async () => {
    const result = await Effect.runPromise(
      validateWorkflowIntegrations(
        [
          createActionNode({
            actionType: "custom/send-message",
            integrationId: "int_1",
          }),
        ],
        slackCatalog,
        () => Effect.succeed({ int_1: "twilio" })
      )
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_ids",
      invalidIds: ["int_1"],
    });
  });

  // A missing integration and a mismatched one are different fixes, so a graph
  // with both is told about the missing one first.
  it("reports a missing integration ahead of a mismatched one", async () => {
    const result = await Effect.runPromise(
      validateWorkflowIntegrations(
        [
          createActionNode({
            actionType: "custom/send-message",
            integrationId: "missing_1",
          }),
          {
            ...createActionNode({
              actionType: "custom/send-sms",
              integrationId: "wrong_type_1",
            }),
            id: "action_2",
          },
        ],
        slackCatalog,
        () => Effect.succeed({ wrong_type_1: "slack" })
      )
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_ids",
      invalidIds: ["missing_1"],
    });
  });

  it("refuses an action that needs a connection and names none", async () => {
    const getIntegrationTypesByIds = vi.fn(() =>
      Effect.succeed({} as Record<string, string>)
    );

    const result = await Effect.runPromise(
      validateWorkflowIntegrations(
        [createActionNode({ actionType: "custom/send-message" })],
        slackCatalog,
        getIntegrationTypesByIds
      )
    );

    expect(result).toEqual({
      valid: false,
      reason: "unconfigured",
      error: expect.stringContaining("connection"),
    });
    expect(getIntegrationTypesByIds).not.toHaveBeenCalled();
  });

  it("passes a graph naming no integration at all", async () => {
    const getIntegrationTypesByIds = vi.fn(() =>
      Effect.succeed({} as Record<string, string>)
    );

    const result = await Effect.runPromise(
      validateWorkflowIntegrations(
        [createActionNode({ actionType: "Condition" })],
        builtInCatalog,
        getIntegrationTypesByIds
      )
    );

    expect(result).toEqual({ valid: true });
    expect(getIntegrationTypesByIds).not.toHaveBeenCalled();
  });

  it("bypasses both refusals when strict validation is off", async () => {
    const result = await Effect.runPromise(
      validateWorkflowIntegrations(
        [
          createActionNode({
            actionType: "custom/send-message",
            integrationId: "missing_1",
          }),
        ],
        slackCatalog,
        () => Effect.succeed({}),
        { strictValidation: false }
      )
    );

    expect(result).toEqual({ valid: true });
  });

  it("bypasses an unconfigured connection when strict validation is off", async () => {
    const result = await Effect.runPromise(
      validateWorkflowIntegrations(
        [createActionNode({ actionType: "custom/send-message" })],
        slackCatalog,
        () => Effect.succeed({}),
        { strictValidation: false }
      )
    );

    expect(result).toEqual({ valid: true });
  });
});

describe("Event Connection references", () => {
  const typesByIds = (types: Record<string, string>) =>
    vi.fn(() => Effect.succeed(types));

  it("collects the Connection a Lifecycle rule binds to an integration Event", () => {
    const ids = extractRequiredIntegrationIds(
      [
        createLifecycleNode({
          startEvents: ["slack/message.posted"],
          cancelEvents: [],
          concurrency: "unlimited",
          connectionIds: { "slack/message.posted": "slack_1" },
        }),
      ],
      eventCatalog
    );

    expect(ids).toEqual(["slack_1"]);
  });

  it("collects the Connection a Wait subscription names", () => {
    const ids = extractRequiredIntegrationIds(
      [
        createWaitNode([
          { event: "slack/message.posted", connectionId: "slack_1" },
        ]),
      ],
      eventCatalog
    );

    expect(ids).toEqual(["slack_1"]);
  });

  it("ignores a Connection bound to a host Event, which needs none", () => {
    const ids = extractRequiredIntegrationIds(
      [
        createLifecycleNode({
          startEvents: ["app/appointment.created"],
          cancelEvents: [],
          concurrency: "unlimited",
          connectionIds: { "app/appointment.created": "stale_id" },
        }),
        createWaitNode([
          { event: "app/appointment.created", connectionId: "stale_id" },
        ]),
      ],
      eventCatalog
    );

    expect(ids).toEqual([]);
  });

  it("ignores a disabled Wait node", () => {
    const node = createWaitNode([
      { event: "slack/message.posted", connectionId: "slack_1" },
    ]);

    const ids = extractRequiredIntegrationIds(
      [{ ...node, data: { ...node.data, enabled: false } }],
      eventCatalog
    );

    expect(ids).toEqual([]);
  });

  it("leaves a blank Connection to the Event checks that name it", () => {
    // checkLifecycleRules and validateWorkflowEvents refuse this with a sentence
    // naming the Event, and both run ahead of this check.
    const ids = extractRequiredIntegrationIds(
      [
        createLifecycleNode({
          startEvents: ["slack/message.posted"],
          cancelEvents: [],
          concurrency: "unlimited",
        }),
      ],
      eventCatalog
    );

    expect(ids).toEqual([]);
  });

  it("refuses a Lifecycle Connection no integration row carries", async () => {
    const result = await Effect.runPromise(
      validateWorkflowIntegrations(
        [
          createLifecycleNode({
            startEvents: ["slack/message.posted"],
            cancelEvents: [],
            concurrency: "unlimited",
            connectionIds: { "slack/message.posted": "deleted_1" },
          }),
        ],
        eventCatalog,
        typesByIds({})
      )
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_ids",
      invalidIds: ["deleted_1"],
    });
  });

  it("refuses a Wait Connection belonging to another integration type", async () => {
    const result = await Effect.runPromise(
      validateWorkflowIntegrations(
        [
          createWaitNode([
            { event: "slack/message.posted", connectionId: "twilio_1" },
          ]),
        ],
        eventCatalog,
        typesByIds({ twilio_1: "twilio" })
      )
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_ids",
      invalidIds: ["twilio_1"],
    });
  });

  it("reads an action and an Event Connection in one query", async () => {
    const getIntegrationTypesByIds = typesByIds({
      slack_1: "slack",
      slack_2: "slack",
    });

    const result = await Effect.runPromise(
      validateWorkflowIntegrations(
        [
          createLifecycleNode({
            startEvents: ["slack/message.posted"],
            cancelEvents: [],
            concurrency: "unlimited",
            connectionIds: { "slack/message.posted": "slack_1" },
          }),
          createActionNode({
            actionType: "custom/send-message",
            integrationId: "slack_2",
          }),
        ],
        eventCatalog,
        getIntegrationTypesByIds
      )
    );

    expect(result).toEqual({ valid: true });
    expect(getIntegrationTypesByIds).toHaveBeenCalledTimes(1);
    expect(getIntegrationTypesByIds).toHaveBeenCalledWith([
      "slack_1",
      "slack_2",
    ]);
  });
});
