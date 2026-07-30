import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { defineIntegration } from "#src/backend/lib/extensions/define-integration";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
import { defineStep } from "#src/backend/lib/steps/define-step";
import {
  extractRequiredIntegrationIds,
  validateWorkflowIntegrations,
} from "#src/backend/lib/workflow-integration-validation";
import type { ExtensionCatalog } from "@rova/shared/extensions/catalog";
import type { WorkflowNode } from "@rova/shared/workflow/types";

// Which integration an action needs is the catalog's answer, and the built-in
// four ride in on an empty assembly.
const builtInCatalog = assembleExtensions({}).catalog;

/** The built-ins beside a host action that names a connection of its own. */
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
        { key: "smsTo", label: "To", type: "template-input", required: true },
      ],
      handler: Effect.fn(function* () {
        return yield* Effect.succeed({ sid: "SM1" });
      }),
    }),
  },
});

describe("extractRequiredIntegrationIds", () => {
  it("includes integration IDs for actions that require integrations", () => {
    const ids = extractRequiredIntegrationIds(
      [
        createActionNode({
          actionType: "Database Query",
          integrationId: "db_1",
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

    expect(ids).toEqual(["db_1", "slack_1"]);
  });

  it("ignores integration IDs on actions that do not require integrations", () => {
    const ids = extractRequiredIntegrationIds(
      [
        createActionNode({
          actionType: "HTTP Request",
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
      actionType: "Database Query",
      integrationId: "db_1",
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
          actionType: "Database Query",
          integrationId: "   ",
        }),
        createActionNode({
          actionType: "Database Query",
        }),
      ],
      builtInCatalog
    );

    expect(ids).toEqual([]);
  });
});

describe("validateWorkflowIntegrations", () => {
  it("deduplicates integration ids before the one read it makes", async () => {
    const getIntegrationTypesByIds = vi.fn(
      (): Promise<Record<string, string>> =>
        Promise.resolve({ shared_integration: "database" })
    );

    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "Database Query",
          integrationId: "shared_integration",
        }),
        {
          ...createActionNode({
            actionType: "Database Query",
            integrationId: "shared_integration",
          }),
          id: "action_2",
        },
      ],
      builtInCatalog,
      { getIntegrationTypesByIds }
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
    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "Database Query",
          integrationId: "db_1",
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
      { getIntegrationTypesByIds: () => Promise.resolve({ slack_1: "slack" }) }
    );

    expect(result).toEqual({ valid: false, invalidIds: ["db_1"] });
  });

  // The catalog is what a save reads. An action it holds carries the integration
  // its nodes must name, and a row of a different type is refused by id.
  it("reads an action's required integration off the assembled catalog", async () => {
    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "twilio/send-sms",
          integrationId: "slack_1",
        }),
      ],
      assembleExtensions({ integrations: [twilio] }).catalog,
      { getIntegrationTypesByIds: () => Promise.resolve({ slack_1: "slack" }) }
    );

    expect(result).toEqual({ valid: false, invalidIds: ["slack_1"] });
  });

  it("rejects integrations with mismatched types", async () => {
    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "Database Query",
          integrationId: "int_1",
        }),
      ],
      builtInCatalog,
      { getIntegrationTypesByIds: () => Promise.resolve({ int_1: "slack" }) }
    );

    expect(result).toEqual({ valid: false, invalidIds: ["int_1"] });
  });

  // A missing integration and a mismatched one are different fixes, so a graph
  // with both is told about the missing one first.
  it("reports a missing integration ahead of a mismatched one", async () => {
    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "Database Query",
          integrationId: "missing_1",
        }),
        {
          ...createActionNode({
            actionType: "Database Query",
            integrationId: "wrong_type_1",
          }),
          id: "action_2",
        },
      ],
      builtInCatalog,
      {
        getIntegrationTypesByIds: () =>
          Promise.resolve({ wrong_type_1: "slack" }),
      }
    );

    expect(result).toEqual({ valid: false, invalidIds: ["missing_1"] });
  });

  it("passes a graph naming no integration at all", async () => {
    const getIntegrationTypesByIds = vi.fn(
      (): Promise<Record<string, string>> => Promise.resolve({})
    );

    const result = await validateWorkflowIntegrations(
      [createActionNode({ actionType: "HTTP Request" })],
      builtInCatalog,
      { getIntegrationTypesByIds }
    );

    expect(result).toEqual({ valid: true });
    expect(getIntegrationTypesByIds).not.toHaveBeenCalled();
  });

  it("bypasses both refusals when strict validation is off", async () => {
    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "Database Query",
          integrationId: "missing_1",
        }),
      ],
      builtInCatalog,
      {
        getIntegrationTypesByIds: () => Promise.resolve({}),
        strictValidation: false,
      }
    );

    expect(result).toEqual({ valid: true });
  });
});
