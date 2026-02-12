import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import {
  createIntegration,
  deleteIntegration as deleteIntegrationById,
  getIntegration as getIntegrationById,
  getIntegrations as getIntegrationsAll,
  updateIntegration,
} from "@/backend/lib/db/integrations";
import { getAppLogger } from "@/backend/lib/logger";
import {
  getCredentialMapping,
  getIntegration as getPluginFromRegistry,
} from "@/plugins";
import type {
  IntegrationConfig,
  IntegrationType,
} from "@/shared/types/integration";
import { getIntegrationTestFunction } from "./integration-test-loaders";

const integrationsLogger = getAppLogger("integrations");
const SECRET_MASK = "********";

function getSecretConfigKeys(type: IntegrationType): Set<string> {
  if (type === "database") {
    return new Set(["url"]);
  }

  const plugin = getPluginFromRegistry(type);
  if (!plugin) {
    return new Set();
  }

  return new Set(
    plugin.formFields
      .filter((field) => field.type === "password")
      .map((field) => field.configKey)
  );
}

function maskIntegrationConfig(
  type: IntegrationType,
  config: IntegrationConfig
): IntegrationConfig {
  const secretKeys = getSecretConfigKeys(type);
  const maskedConfig: IntegrationConfig = { ...config };

  for (const key of secretKeys) {
    if (typeof maskedConfig[key] === "string" && maskedConfig[key]) {
      maskedConfig[key] = SECRET_MASK;
    }
  }

  return maskedConfig;
}

function mergeIntegrationConfig(
  type: IntegrationType,
  currentConfig: IntegrationConfig,
  updates?: IntegrationConfig
): IntegrationConfig {
  if (!updates) {
    return currentConfig;
  }

  const secretKeys = getSecretConfigKeys(type);
  const sanitizedUpdates = omitBy(
    updates,
    (value, key) =>
      value === undefined ||
      (secretKeys.has(key as string) &&
        (value === SECRET_MASK || value.trim().length === 0))
  );

  return {
    ...currentConfig,
    ...sanitizedUpdates,
  };
}

export async function getIntegrations(type?: IntegrationType) {
  const requestLogger = integrationsLogger.with({ type: type ?? null });
  try {
    const integrations = await getIntegrationsAll(type);

    const response = integrations.map((integration) => ({
      id: integration.id,
      name: integration.name,
      type: integration.type,
      isManaged: integration.isManaged ?? false,
      createdAt: integration.createdAt.toISOString(),
      updatedAt: integration.updatedAt.toISOString(),
    }));

    return Response.json(response);
  } catch (error) {
    requestLogger.error("Failed to get integrations", { error });
    return Response.json(
      {
        error: "Failed to get integrations",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

export async function getIntegration(integrationId: string) {
  const requestLogger = integrationsLogger.with({ integrationId });
  try {
    const integration = await getIntegrationById(integrationId);

    if (!integration) {
      requestLogger.warn("Integration not found");
      return Response.json({ error: "Integration not found" }, { status: 404 });
    }

    const response = {
      id: integration.id,
      name: integration.name,
      type: integration.type,
      config: maskIntegrationConfig(integration.type, integration.config),
      createdAt: integration.createdAt.toISOString(),
      updatedAt: integration.updatedAt.toISOString(),
    };

    return Response.json(response);
  } catch (error) {
    requestLogger.error("Failed to get integration", { error });
    return Response.json(
      {
        error: "Failed to get integration",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

export async function putIntegration(
  integrationId: string,
  body: {
    name?: string;
    config?: IntegrationConfig;
  }
) {
  const requestLogger = integrationsLogger.with({ integrationId });
  try {
    const existingIntegration = await getIntegrationById(integrationId);

    if (!existingIntegration) {
      requestLogger.warn("Integration not found for update");
      return Response.json({ error: "Integration not found" }, { status: 404 });
    }

    const mergedConfig = body.config
      ? mergeIntegrationConfig(
          existingIntegration.type,
          existingIntegration.config,
          body.config
        )
      : undefined;

    const updatePayload = omitBy(
      {
        name: body.name,
        config: mergedConfig,
      },
      isNil
    ) as {
      name?: string;
      config?: IntegrationConfig;
    };

    const integration = await updateIntegration(integrationId, updatePayload);

    if (!integration) {
      requestLogger.warn("Integration not found for update");
      return Response.json({ error: "Integration not found" }, { status: 404 });
    }

    const response = {
      id: integration.id,
      name: integration.name,
      type: integration.type,
      config: maskIntegrationConfig(integration.type, integration.config),
      createdAt: integration.createdAt.toISOString(),
      updatedAt: integration.updatedAt.toISOString(),
    };

    return Response.json(response);
  } catch (error) {
    requestLogger.error("Failed to update integration", { error });
    return Response.json(
      {
        error: "Failed to update integration",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

export async function deleteIntegration(integrationId: string) {
  const requestLogger = integrationsLogger.with({ integrationId });
  try {
    const success = await deleteIntegrationById(integrationId);

    if (!success) {
      requestLogger.warn("Integration not found for delete");
      return Response.json({ error: "Integration not found" }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (error) {
    requestLogger.error("Failed to delete integration", { error });
    return Response.json(
      {
        error: "Failed to delete integration",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

export async function postIntegrationsTest(body: {
  type: IntegrationType;
  config: IntegrationConfig;
}) {
  const requestLogger = integrationsLogger.with({ type: body.type });
  try {
    if (body.type === "database") {
      const result = await testDatabaseConnection(body.config.url);
      return Response.json(result);
    }

    const plugin = getPluginFromRegistry(body.type);

    if (!plugin) {
      requestLogger.warn("Invalid integration type for test");
      return Response.json(
        { error: "Invalid integration type" },
        { status: 400 }
      );
    }

    const testFn = await getIntegrationTestFunction(body.type);
    if (!testFn) {
      requestLogger.warn("Integration does not support test endpoint");
      return Response.json(
        { error: "Integration does not support testing" },
        { status: 400 }
      );
    }

    const credentials = getCredentialMapping(plugin, body.config);
    const testResult = await testFn(credentials);

    const result = {
      status: testResult.success ? "success" : "error",
      message: testResult.success
        ? "Connection successful"
        : testResult.error || "Connection failed",
    };

    return Response.json(result);
  } catch (error) {
    requestLogger.error("Failed to test integration connection", { error });
    return Response.json(
      {
        status: "error",
        message:
          error instanceof Error ? error.message : "Failed to test connection",
      },
      { status: 500 }
    );
  }
}

export async function postIntegrationTest(integrationId: string) {
  const requestLogger = integrationsLogger.with({ integrationId });
  try {
    const integration = await getIntegrationById(integrationId);

    if (!integration) {
      requestLogger.warn("Integration not found for test");
      return Response.json({ error: "Integration not found" }, { status: 404 });
    }

    if (integration.type === "database") {
      const result = await testDatabaseConnection(integration.config.url);
      return Response.json(result);
    }

    const plugin = getPluginFromRegistry(integration.type);

    if (!plugin) {
      requestLogger.warn(
        "Invalid integration type for saved integration test",
        {
          type: integration.type,
        }
      );
      return Response.json(
        { error: "Invalid integration type" },
        { status: 400 }
      );
    }

    const testFn = await getIntegrationTestFunction(integration.type);
    if (!testFn) {
      requestLogger.warn(
        "Saved integration type does not support test endpoint",
        {
          type: integration.type,
        }
      );
      return Response.json(
        { error: "Integration does not support testing" },
        { status: 400 }
      );
    }

    const credentials = getCredentialMapping(plugin, integration.config);
    const testResult = await testFn(credentials);

    const result = {
      status: testResult.success ? "success" : "error",
      message: testResult.success
        ? "Connection successful"
        : testResult.error || "Connection failed",
    };

    return Response.json(result);
  } catch (error) {
    requestLogger.error("Failed to test saved integration connection", {
      error,
    });
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to test connection",
      },
      { status: 500 }
    );
  }
}

async function testDatabaseConnection(databaseUrl?: string) {
  const createDatabaseConnection = (url: string) =>
    new Bun.SQL(url, {
      max: 1,
      idleTimeout: 5,
      connectionTimeout: 5,
    });

  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  try {
    if (!databaseUrl) {
      return {
        status: "error",
        message: "Connection failed",
      };
    }

    connection = createDatabaseConnection(databaseUrl);

    await connection`SELECT 1`;

    return {
      status: "success",
      message: "Connection successful",
    };
  } catch {
    return {
      status: "error",
      message: "Connection failed",
    };
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

export async function postIntegrations(body: {
  name?: string;
  type: IntegrationType;
  config: IntegrationConfig;
}) {
  const requestLogger = integrationsLogger.with({ type: body.type });
  try {
    const integration = await createIntegration(
      body.name || "",
      body.type,
      body.config
    );

    const response = {
      id: integration.id,
      name: integration.name,
      type: integration.type,
      createdAt: integration.createdAt.toISOString(),
      updatedAt: integration.updatedAt.toISOString(),
    };

    return Response.json(response);
  } catch (error) {
    requestLogger.error("Failed to create integration", { error });
    return Response.json(
      {
        error: "Failed to create integration",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
