import { omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import postgres, { type Sql } from "postgres";
import {
  createIntegration,
  deleteIntegration as deleteIntegrationById,
  getIntegration as getIntegrationById,
  getIntegrations as getIntegrationsAll,
  updateIntegration,
} from "@/backend/lib/db/integrations";
import { responseFromServiceResult } from "@/backend/lib/http/response-from-service-result";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import {
  getCredentialMapping,
  getIntegration as getPluginFromRegistry,
} from "@/plugins/registry";
import type {
  IntegrationConfig,
  IntegrationType,
} from "@/shared/types/integration";
import { getIntegrationTestFunction } from "./integration-test-loaders";

const integrationsLogger = getAppLogger("integrations");
const SECRET_MASK = "********";

type IntegrationSummary = {
  id: string;
  name: string;
  type: IntegrationType;
  isManaged?: boolean;
  createdAt: string;
  updatedAt: string;
};

type IntegrationWithConfig = IntegrationSummary & {
  config: IntegrationConfig;
};

type IntegrationTestResult = {
  status: "success" | "error";
  message: string;
};

type IntegrationError = {
  error: string;
  details?: string;
};

type IntegrationTestError =
  | IntegrationError
  | {
      status: "error";
      message: string;
    };

const createDatabaseConnection = (url: string): Sql =>
  postgres(url, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
  });

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
      (typeof key === "string" &&
        secretKeys.has(key) &&
        (value === SECRET_MASK ||
          (typeof value === "string" && value.trim().length === 0)))
  );

  return {
    ...currentConfig,
    ...sanitizedUpdates,
  };
}

function toIntegrationSummary(input: {
  id: string;
  name: string;
  type: IntegrationType;
  isManaged?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}): IntegrationSummary {
  return {
    id: input.id,
    name: input.name,
    type: input.type,
    isManaged: input.isManaged ?? false,
    createdAt: input.createdAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
  };
}

function toIntegrationWithConfig(input: {
  id: string;
  name: string;
  type: IntegrationType;
  config: IntegrationConfig;
  isManaged?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}): IntegrationWithConfig {
  return {
    ...toIntegrationSummary(input),
    config: maskIntegrationConfig(input.type, input.config),
  };
}

export async function getIntegrationsResult(
  type?: IntegrationType
): Promise<ServiceResult<IntegrationSummary[], 500, IntegrationError>> {
  const requestLogger = integrationsLogger.with({ type: type ?? null });
  try {
    const integrations = await getIntegrationsAll(type);
    return success(integrations.map(toIntegrationSummary));
  } catch (error) {
    requestLogger.error("Failed to get integrations", { error });
    return failure(500, {
      error: "Failed to get integrations",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function getIntegrations(type?: IntegrationType) {
  return responseFromServiceResult(await getIntegrationsResult(type));
}

export async function getIntegrationResult(
  integrationId: string
): Promise<
  ServiceResult<
    IntegrationWithConfig,
    404 | 500,
    { error: string; details?: string }
  >
> {
  const requestLogger = integrationsLogger.with({ integrationId });
  try {
    const integration = await getIntegrationById(integrationId);

    if (!integration) {
      requestLogger.warn("Integration not found");
      return failure(404, { error: "Integration not found" });
    }

    return success(toIntegrationWithConfig(integration));
  } catch (error) {
    requestLogger.error("Failed to get integration", { error });
    return failure(500, {
      error: "Failed to get integration",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function getIntegration(integrationId: string) {
  return responseFromServiceResult(await getIntegrationResult(integrationId));
}

export async function putIntegrationResult(
  integrationId: string,
  body: {
    name?: string;
    config?: IntegrationConfig;
  }
): Promise<
  ServiceResult<
    IntegrationWithConfig,
    404 | 500,
    { error: string; details?: string }
  >
> {
  const requestLogger = integrationsLogger.with({ integrationId });
  try {
    const existingIntegration = await getIntegrationById(integrationId);

    if (!existingIntegration) {
      requestLogger.warn("Integration not found for update");
      return failure(404, { error: "Integration not found" });
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
    );

    const integration = await updateIntegration(integrationId, updatePayload);

    if (!integration) {
      requestLogger.warn("Integration not found for update");
      return failure(404, { error: "Integration not found" });
    }

    return success(toIntegrationWithConfig(integration));
  } catch (error) {
    requestLogger.error("Failed to update integration", { error });
    return failure(500, {
      error: "Failed to update integration",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function putIntegration(
  integrationId: string,
  body: {
    name?: string;
    config?: IntegrationConfig;
  }
) {
  return responseFromServiceResult(
    await putIntegrationResult(integrationId, body)
  );
}

export async function deleteIntegrationResult(
  integrationId: string
): Promise<ServiceResult<{ success: true }, 404 | 500, IntegrationError>> {
  const requestLogger = integrationsLogger.with({ integrationId });
  try {
    const deleted = await deleteIntegrationById(integrationId);

    if (!deleted) {
      requestLogger.warn("Integration not found for delete");
      return failure(404, { error: "Integration not found" });
    }

    return success({ success: true });
  } catch (error) {
    requestLogger.error("Failed to delete integration", { error });
    return failure(500, {
      error: "Failed to delete integration",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function deleteIntegration(integrationId: string) {
  return responseFromServiceResult(
    await deleteIntegrationResult(integrationId)
  );
}

export async function postIntegrationsTestResult(body: {
  type: IntegrationType;
  config: IntegrationConfig;
}): Promise<
  ServiceResult<IntegrationTestResult, 400 | 500, IntegrationTestError>
> {
  const requestLogger = integrationsLogger.with({ type: body.type });
  try {
    if (body.type === "database") {
      const result = await testDatabaseConnection(body.config.url);
      return success(result);
    }

    const plugin = getPluginFromRegistry(body.type);

    if (!plugin) {
      requestLogger.warn("Invalid integration type for test");
      return failure(400, { error: "Invalid integration type" });
    }

    const testFn = await getIntegrationTestFunction(body.type);
    if (!testFn) {
      requestLogger.warn("Integration does not support test endpoint");
      return failure(400, { error: "Integration does not support testing" });
    }

    const credentials = getCredentialMapping(plugin, body.config);
    const testResult = await testFn(credentials);

    return success({
      status: testResult.success ? "success" : "error",
      message: testResult.success
        ? "Connection successful"
        : testResult.error || "Connection failed",
    });
  } catch (error) {
    requestLogger.error("Failed to test integration connection", { error });
    return failure(500, {
      status: "error",
      message:
        error instanceof Error ? error.message : "Failed to test connection",
    });
  }
}

export async function postIntegrationsTest(body: {
  type: IntegrationType;
  config: IntegrationConfig;
}) {
  return responseFromServiceResult(await postIntegrationsTestResult(body));
}

export async function postIntegrationTestResult(
  integrationId: string
): Promise<
  ServiceResult<IntegrationTestResult, 400 | 404 | 500, IntegrationError>
> {
  const requestLogger = integrationsLogger.with({ integrationId });
  try {
    const integration = await getIntegrationById(integrationId);

    if (!integration) {
      requestLogger.warn("Integration not found for test");
      return failure(404, { error: "Integration not found" });
    }

    if (integration.type === "database") {
      const result = await testDatabaseConnection(integration.config.url);
      return success(result);
    }

    const plugin = getPluginFromRegistry(integration.type);

    if (!plugin) {
      requestLogger.warn(
        "Invalid integration type for saved integration test",
        {
          type: integration.type,
        }
      );
      return failure(400, { error: "Invalid integration type" });
    }

    const testFn = await getIntegrationTestFunction(integration.type);
    if (!testFn) {
      requestLogger.warn(
        "Saved integration type does not support test endpoint",
        {
          type: integration.type,
        }
      );
      return failure(400, { error: "Integration does not support testing" });
    }

    const credentials = getCredentialMapping(plugin, integration.config);
    const testResult = await testFn(credentials);

    return success({
      status: testResult.success ? "success" : "error",
      message: testResult.success
        ? "Connection successful"
        : testResult.error || "Connection failed",
    });
  } catch (error) {
    requestLogger.error("Failed to test saved integration connection", {
      error,
    });
    return failure(500, {
      error:
        error instanceof Error ? error.message : "Failed to test connection",
    });
  }
}

export async function postIntegrationTest(integrationId: string) {
  return responseFromServiceResult(
    await postIntegrationTestResult(integrationId)
  );
}

async function testDatabaseConnection(
  databaseUrl?: string
): Promise<IntegrationTestResult> {
  let connection: Sql | null = null;

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
      await connection.end();
    }
  }
}

export async function postIntegrationsResult(body: {
  name?: string;
  type: IntegrationType;
  config: IntegrationConfig;
}): Promise<ServiceResult<IntegrationSummary, 500, IntegrationError>> {
  const requestLogger = integrationsLogger.with({ type: body.type });
  try {
    const integration = await createIntegration(
      body.name || "",
      body.type,
      body.config
    );

    return success(toIntegrationSummary(integration));
  } catch (error) {
    requestLogger.error("Failed to create integration", { error });
    return failure(500, {
      error: "Failed to create integration",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function postIntegrations(body: {
  name?: string;
  type: IntegrationType;
  config: IntegrationConfig;
}) {
  return responseFromServiceResult(await postIntegrationsResult(body));
}
