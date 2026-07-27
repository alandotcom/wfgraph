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
  getIntegrationTypes,
  getIntegration as getPluginFromRegistry,
} from "@/plugins/registry";
import type {
  IntegrationConfig,
  IntegrationType,
} from "@/shared/types/integration";
import { getErrorMessage } from "@/shared/utils";
import {
  createSecretConfigKeyTest,
  maskIntegrationConfig,
  SECRET_MASK,
} from "./integration-config-masking";
import { getIntegrationTestFunction } from "./integration-test-loaders";

const integrationsLogger = getAppLogger("integrations");

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

// Reaching here means the integration's metadata is registered but its
// connection test is not, which is what importing "@rova/plugins" without
// "@rova/plugins/server" leaves behind. Naming the missing import beats telling
// someone their integration does not support a test it does support.
const MISSING_TEST_MESSAGE =
  'Connection testing is unavailable for this integration. A host that imports "@rova/plugins" also has to import "@rova/plugins/server", which registers the connection tests.';

const createDatabaseConnection = (url: string): Sql =>
  postgres(url, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
  });

function mergeIntegrationConfig(
  type: IntegrationType,
  currentConfig: IntegrationConfig,
  updates?: IntegrationConfig
): IntegrationConfig {
  if (!updates) {
    return currentConfig;
  }

  const isSecretKey = createSecretConfigKeyTest(type);
  const sanitizedUpdates = omitBy(
    updates,
    (value, key) =>
      value === undefined ||
      (typeof key === "string" &&
        isSecretKey(key) &&
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
): Promise<ServiceResult<IntegrationSummary[], "internal", IntegrationError>> {
  const requestLogger = integrationsLogger.with({ type: type ?? null });
  try {
    const integrations = await getIntegrationsAll(type);
    return success(integrations.map(toIntegrationSummary));
  } catch (error) {
    requestLogger.error(
      `Failed to get integrations: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error: "Failed to get integrations",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function getIntegrationResult(
  integrationId: string
): Promise<
  ServiceResult<
    IntegrationWithConfig,
    "not_found" | "internal",
    { error: string; details?: string }
  >
> {
  const requestLogger = integrationsLogger.with({ integrationId });
  try {
    const integration = await getIntegrationById(integrationId);

    if (!integration) {
      requestLogger.warn("Integration not found");
      return failure("not_found", { error: "Integration not found" });
    }

    return success(toIntegrationWithConfig(integration));
  } catch (error) {
    requestLogger.error(
      `Failed to get integration: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
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
    "not_found" | "internal",
    { error: string; details?: string }
  >
> {
  const requestLogger = integrationsLogger.with({ integrationId });
  try {
    const existingIntegration = await getIntegrationById(integrationId);

    if (!existingIntegration) {
      requestLogger.warn("Integration not found for update");
      return failure("not_found", { error: "Integration not found" });
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
      return failure("not_found", { error: "Integration not found" });
    }

    return success(toIntegrationWithConfig(integration));
  } catch (error) {
    requestLogger.error(
      `Failed to update integration: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
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
): Promise<
  ServiceResult<{ success: true }, "not_found" | "internal", IntegrationError>
> {
  const requestLogger = integrationsLogger.with({ integrationId });
  try {
    const deleted = await deleteIntegrationById(integrationId);

    if (!deleted) {
      requestLogger.warn("Integration not found for delete");
      return failure("not_found", { error: "Integration not found" });
    }

    return success({ success: true });
  } catch (error) {
    requestLogger.error(
      `Failed to delete integration: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error: "Failed to delete integration",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function postIntegrationsTestResult(body: {
  type: IntegrationType;
  config: IntegrationConfig;
}): Promise<
  ServiceResult<
    IntegrationTestResult,
    "invalid" | "internal",
    IntegrationTestError
  >
> {
  const requestLogger = integrationsLogger.with({
    type: body.type,
    configKeys: Object.keys(body.config),
  });
  try {
    if (body.type === "database") {
      const result = await testDatabaseConnection(body.config.url);
      return success(result);
    }

    const plugin = getPluginFromRegistry(body.type);

    if (!plugin) {
      requestLogger.warn("Invalid integration type for test", {
        availableTypes: getIntegrationTypes(),
      });
      return failure("invalid", { error: "Invalid integration type" });
    }

    const testFn = await getIntegrationTestFunction(body.type);
    if (!testFn) {
      requestLogger.warn(MISSING_TEST_MESSAGE);
      return failure("invalid", { error: MISSING_TEST_MESSAGE });
    }

    const credentials = getCredentialMapping(plugin, body.config);
    const credentialPresence = Object.fromEntries(
      Object.entries(credentials).map(([key, value]) => [
        key,
        value ? "present" : "empty",
      ])
    );
    requestLogger.info("Testing integration credentials", {
      credentialKeys: Object.keys(credentials),
      credentialPresence,
    });
    const testResult = await testFn(credentials);

    if (!testResult.success) {
      requestLogger.warn(
        `Integration test returned failure: ${testResult.error}`,
        {
          error: testResult.error,
          details: testResult.details,
        }
      );
    }

    return success({
      status: testResult.success ? "success" : "error",
      message: testResult.success
        ? "Connection successful"
        : testResult.error || "Connection failed",
    });
  } catch (error) {
    requestLogger.error(
      `Failed to test integration connection: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      status: "error",
      message:
        error instanceof Error ? error.message : "Failed to test connection",
    });
  }
}

export async function postIntegrationTestResult(
  integrationId: string
): Promise<
  ServiceResult<
    IntegrationTestResult,
    "invalid" | "not_found" | "internal",
    IntegrationError
  >
> {
  const requestLogger = integrationsLogger.with({ integrationId });
  try {
    const integration = await getIntegrationById(integrationId);

    if (!integration) {
      requestLogger.warn("Integration not found for test");
      return failure("not_found", { error: "Integration not found" });
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
      return failure("invalid", { error: "Invalid integration type" });
    }

    const testFn = await getIntegrationTestFunction(integration.type);
    if (!testFn) {
      requestLogger.warn(MISSING_TEST_MESSAGE, { type: integration.type });
      return failure("invalid", { error: MISSING_TEST_MESSAGE });
    }

    const credentials = getCredentialMapping(plugin, integration.config);
    const credentialPresence = Object.fromEntries(
      Object.entries(credentials).map(([key, value]) => [
        key,
        value ? "present" : "empty",
      ])
    );
    requestLogger.info("Testing integration credentials", {
      type: integration.type,
      credentialKeys: Object.keys(credentials),
      credentialPresence,
    });
    const testResult = await testFn(credentials);

    if (!testResult.success) {
      requestLogger.warn(
        `Integration test returned failure: ${testResult.error}`,
        {
          error: testResult.error,
          details: testResult.details,
        }
      );
    }

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
    return failure("internal", {
      error:
        error instanceof Error ? error.message : "Failed to test connection",
    });
  }
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
}): Promise<
  ServiceResult<IntegrationSummary, "invalid" | "internal", IntegrationError>
> {
  const requestLogger = integrationsLogger.with({ type: body.type });

  // The editor bundled with @rova/core lists every built-in integration, while
  // the server only knows the ones something registered. Refusing here is what
  // keeps that gap from turning into credentials stored for an integration this
  // process cannot run, which would then be neither testable nor maskable.
  if (body.type !== "database" && !getPluginFromRegistry(body.type)) {
    return failure("invalid", {
      error: `Integration "${body.type}" is not available on this server. Import "@rova/plugins" to enable the built-in integrations.`,
    });
  }

  try {
    const integration = await createIntegration(
      body.name || "",
      body.type,
      body.config
    );

    return success(toIntegrationSummary(integration));
  } catch (error) {
    requestLogger.error(
      `Failed to create integration: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error: "Failed to create integration",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
