import { describe, expect, it, vi } from "bun:test";
import {
  extractRequiredIntegrationIds,
  type ResolveActionByType,
  validateWorkflowIntegrations,
} from "@/backend/lib/workflow-integration-validation";
import type { IntegrationType } from "@rova/shared/types/integration";
import type { WorkflowNode } from "@rova/shared/workflow/types";

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
  it("deduplicates integration IDs before validation and type lookup", async () => {
    const validateIntegrationIds = vi.fn(() =>
      Promise.resolve({ valid: true })
    );
    const getIntegrationTypesByIds = vi.fn(
      (): Promise<Record<string, IntegrationType>> =>
        Promise.resolve({
          shared_integration: "database",
        })
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
      {
        validateIntegrationIds,
        getIntegrationTypesByIds,
      }
    );

    expect(result).toEqual({ valid: true });
    expect(validateIntegrationIds).toHaveBeenCalledWith(["shared_integration"]);
    expect(getIntegrationTypesByIds).toHaveBeenCalledWith([
      "shared_integration",
    ]);
  });

  it("delegates to the provided integration validator", async () => {
    const capturedIds: string[][] = [];
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
        validateIntegrationIds: (integrationIds) => {
          capturedIds.push(integrationIds);
          return Promise.resolve({ valid: false, invalidIds: ["db_1"] });
        },
      }
    );

    expect(capturedIds).toEqual([["db_1", "slack_1"]]);
    expect(result).toEqual({ valid: false, invalidIds: ["db_1"] });
  });

  it("rejects integrations with mismatched types", async () => {
    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "Database Query",
          integrationId: "int_1",
        }),
      ],
      {
        validateIntegrationIds: () => Promise.resolve({ valid: true }),
        getIntegrationTypesByIds: () =>
          Promise.resolve({
            int_1: "slack",
          }),
      }
    );

    expect(result).toEqual({ valid: false, invalidIds: ["int_1"] });
  });

  it("stops after existence validation failure", async () => {
    const getIntegrationTypesByIds = vi.fn(
      (): Promise<Record<string, IntegrationType>> =>
        Promise.resolve({ int_1: "database" })
    );

    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "Database Query",
          integrationId: "int_1",
        }),
      ],
      {
        validateIntegrationIds: () =>
          Promise.resolve({ valid: false, invalidIds: ["int_1"] }),
        getIntegrationTypesByIds,
      }
    );

    expect(result).toEqual({ valid: false, invalidIds: ["int_1"] });
    expect(getIntegrationTypesByIds).not.toHaveBeenCalled();
  });

  it("deduplicates mismatched integration IDs in the response", async () => {
    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "Database Query",
          integrationId: "int_1",
        }),
        {
          ...createActionNode({
            actionType: "Database Query",
            integrationId: "int_1",
          }),
          id: "action_2",
        },
      ],
      {
        validateIntegrationIds: () => Promise.resolve({ valid: true }),
        getIntegrationTypesByIds: () =>
          Promise.resolve({
            int_1: "slack",
          }),
      }
    );

    expect(result).toEqual({ valid: false, invalidIds: ["int_1"] });
  });

  it("accepts integrations that exist with matching types", async () => {
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
        validateIntegrationIds: () => Promise.resolve({ valid: true }),
        getIntegrationTypesByIds: () =>
          Promise.resolve({
            db_1: "database",
            slack_1: "slack",
          }),
      }
    );

    expect(result).toEqual({ valid: true });
  });

  it("supports bypassing missing integration failures when strict validation is disabled", async () => {
    const getIntegrationTypesByIds = vi.fn(
      (): Promise<Record<string, IntegrationType>> =>
        Promise.resolve({ int_1: "database" })
    );

    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "Database Query",
          integrationId: "int_1",
        }),
      ],
      {
        strictValidation: false,
        validateIntegrationIds: () =>
          Promise.resolve({ valid: false, invalidIds: ["int_1"] }),
        getIntegrationTypesByIds,
      }
    );

    expect(result).toEqual({ valid: true });
    expect(getIntegrationTypesByIds).not.toHaveBeenCalled();
  });

  it("supports bypassing integration type mismatches when strict validation is disabled", async () => {
    const result = await validateWorkflowIntegrations(
      [
        createActionNode({
          actionType: "Database Query",
          integrationId: "int_1",
        }),
      ],
      {
        strictValidation: false,
        validateIntegrationIds: () => Promise.resolve({ valid: true }),
        getIntegrationTypesByIds: () =>
          Promise.resolve({
            int_1: "slack",
          }),
      }
    );

    expect(result).toEqual({ valid: true });
  });
});
