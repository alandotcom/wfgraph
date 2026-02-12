import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getIntegration,
  putIntegration,
} from "@/backend/services/integrations/integrations.integrations";

const mocks = vi.hoisted(() => {
  const createIntegration = vi.fn();
  const deleteIntegration = vi.fn();
  const getIntegrationById = vi.fn();
  const getIntegrations = vi.fn();
  const updateIntegration = vi.fn();
  const getCredentialMapping = vi.fn();
  const getPluginFromRegistry = vi.fn();
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    with: vi.fn(),
  };

  logger.with.mockReturnValue(logger);

  return {
    createIntegration,
    deleteIntegration,
    getIntegrationById,
    getIntegrations,
    updateIntegration,
    getCredentialMapping,
    getPluginFromRegistry,
    logger,
  };
});

vi.mock("@/lib/db/integrations", () => ({
  createIntegration: mocks.createIntegration,
  deleteIntegration: mocks.deleteIntegration,
  getIntegration: mocks.getIntegrationById,
  getIntegrations: mocks.getIntegrations,
  updateIntegration: mocks.updateIntegration,
}));

vi.mock("@/plugins", () => ({
  getCredentialMapping: mocks.getCredentialMapping,
  getIntegration: mocks.getPluginFromRegistry,
}));

vi.mock("@/lib/logger", () => ({
  getAppLogger: () => mocks.logger,
}));

describe("integration service secret handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logger.with.mockReturnValue(mocks.logger);
    mocks.getPluginFromRegistry.mockReturnValue({
      formFields: [
        {
          id: "apiKey",
          label: "API Key",
          type: "password",
          configKey: "apiKey",
        },
        {
          id: "teamId",
          label: "Team ID",
          type: "text",
          configKey: "teamId",
        },
      ],
    });
  });

  it("masks secret fields in getIntegration response", async () => {
    mocks.getIntegrationById.mockResolvedValueOnce({
      id: "int_1",
      name: "Slack Prod",
      type: "slack",
      config: {
        apiKey: "xoxb-secret",
        teamId: "team-123",
      },
      isManaged: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const response = await getIntegration("int_1");
    const json = (await response.json()) as {
      config: { apiKey?: string; teamId?: string };
    };

    expect(json.config.apiKey).toBe("********");
    expect(json.config.teamId).toBe("team-123");
  });

  it("preserves masked secrets and merges partial config updates", async () => {
    const existing = {
      id: "int_1",
      name: "Slack Prod",
      type: "slack" as const,
      config: {
        apiKey: "old-secret",
        teamId: "team-old",
      },
      isManaged: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };

    mocks.getIntegrationById.mockResolvedValueOnce(existing);
    mocks.updateIntegration.mockImplementationOnce(
      async (
        integrationId: string,
        updates: {
          name?: string;
          config?: { apiKey?: string; teamId?: string };
        }
      ) => ({
        ...existing,
        id: integrationId,
        name: updates.name ?? existing.name,
        config: updates.config ?? existing.config,
        updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      })
    );

    const response = await putIntegration("int_1", {
      name: "Slack Updated",
      config: {
        apiKey: "********",
        teamId: "team-new",
      },
    });

    expect(mocks.updateIntegration).toHaveBeenCalledWith("int_1", {
      name: "Slack Updated",
      config: {
        apiKey: "old-secret",
        teamId: "team-new",
      },
    });

    const json = (await response.json()) as {
      config: { apiKey?: string; teamId?: string };
    };

    expect(json.config.apiKey).toBe("********");
    expect(json.config.teamId).toBe("team-new");
  });

  it("replaces secret when a new value is provided", async () => {
    const existing = {
      id: "int_1",
      name: "Slack Prod",
      type: "slack" as const,
      config: {
        apiKey: "old-secret",
        teamId: "team-old",
      },
      isManaged: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };

    mocks.getIntegrationById.mockResolvedValueOnce(existing);
    mocks.updateIntegration.mockImplementationOnce(
      async (
        integrationId: string,
        updates: {
          name?: string;
          config?: { apiKey?: string; teamId?: string };
        }
      ) => ({
        ...existing,
        id: integrationId,
        name: updates.name ?? existing.name,
        config: updates.config ?? existing.config,
        updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      })
    );

    await putIntegration("int_1", {
      config: {
        apiKey: "new-secret",
      },
    });

    expect(mocks.updateIntegration).toHaveBeenCalledWith("int_1", {
      name: undefined,
      config: {
        apiKey: "new-secret",
        teamId: "team-old",
      },
    });
  });
});
