import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearExtensions,
  configureExtensions,
} from "#src/backend/lib/extensions/current";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
import {
  extractRequiredIntegrationIds,
  type ResolveActionByType,
  validateWorkflowIntegrations,
} from "#src/backend/lib/workflow-integration-validation";
import type { IntegrationType } from "@rova/shared/types/integration";
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

const resolveActionByType: ResolveActionByType = (actionType) => {
  if (actionType === "custom/send-message") {
    return { integration: "slack" };
  }
  return undefined;
};

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
      resolveActionByType
    );

    expect(ids).toEqual(["db_1", "slack_1"]);
  });

  it("ignores integration IDs on actions that do not require integrations", () => {
    const ids = extractRequiredIntegrationIds([
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
    ]);

    expect(ids).toEqual([]);
  });

  it("ignores disabled nodes and empty values", () => {
    const disabledNode = createActionNode({
      actionType: "Database Query",
      integrationId: "db_1",
    });

    const ids = extractRequiredIntegrationIds([
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
    ]);

    expect(ids).toEqual([]);
  });
});

describe("validateWorkflowIntegrations", () => {
  it("deduplicates integration ids before the one read it makes", async () => {
    const getIntegrationTypesByIds = vi.fn(
      (): Promise<Record<string, IntegrationType>> =>
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
      {
        resolveActionByType,
        getIntegrationTypesByIds: () => Promise.resolve({ slack_1: "slack" }),
      }
    );

    expect(result).toEqual({ valid: false, invalidIds: ["db_1"] });
  });

  // The default resolver is the assembled catalog, which is what a save uses. An
  // action it holds carries the integration its nodes must name, and a row of a
  // different type is refused by id.
  it("reads an action's required integration off the assembled catalog", async () => {
    configureExtensions(
      assembleExtensions({
        registries: {
          actions: [
            {
              id: "twilio/send-sms",
              label: "Send SMS",
              description: "Sends a message",
              category: "Twilio",
              integration: "twilio",
              configFields: [],
              outputFields: [],
            },
          ],
          integrations: [],
        },
      })
    );

    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "twilio/send-sms",
          integrationId: "slack_1",
        }),
      ],
      { getIntegrationTypesByIds: () => Promise.resolve({ slack_1: "slack" }) }
    );

    expect(result).toEqual({ valid: false, invalidIds: ["slack_1"] });

    // Back to the empty surface the rest of the file assembled.
    configureExtensions(assembleExtensions({}));
  });

  it("rejects integrations with mismatched types", async () => {
    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "Database Query",
          integrationId: "int_1",
        }),
      ],
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
      {
        getIntegrationTypesByIds: () =>
          Promise.resolve({ wrong_type_1: "slack" }),
      }
    );

    expect(result).toEqual({ valid: false, invalidIds: ["missing_1"] });
  });

  it("passes a graph naming no integration at all", async () => {
    const getIntegrationTypesByIds = vi.fn(
      (): Promise<Record<string, IntegrationType>> => Promise.resolve({})
    );

    const result = await validateWorkflowIntegrations(
      [createActionNode({ actionType: "HTTP Request" })],
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
      {
        getIntegrationTypesByIds: () => Promise.resolve({}),
        strictValidation: false,
      }
    );

    expect(result).toEqual({ valid: true });
  });
});
