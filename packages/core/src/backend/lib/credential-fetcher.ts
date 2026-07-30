/**
 * Credential Fetcher
 *
 * SECURITY: Steps should fetch credentials at runtime using only an integration ID reference.
 * This ensures:
 * 1. Credentials are never passed as step parameters (not logged in observability)
 * 2. Credentials are reconstructed in secure, non-persisted contexts (in-memory only)
 * 3. Works for both production and test runs
 *
 * Pattern:
 * - Step input: { integrationId: "abc123", ...otherParams }  ← Safe to log
 * - Step fetches: credentials = await fetchCredentials(integrationId)  ← Not logged
 * - Step uses: apiClient.call(credentials.apiKey)  ← In memory only
 * - Step returns: { result: data }  ← Safe to log (no credentials)
 */

import {
  credentialsFromConfig,
  findIntegration,
} from "@rova/shared/extensions/catalog";
import type { IntegrationConfig } from "@rova/shared/types/integration";
import { getExtensions } from "./extensions/current";
import { getIntegrationById } from "./db/integrations";
import { getAppLogger } from "./logger";

const credentialFetcherLogger = getAppLogger("credentials", "fetcher");

/** A handler's own credential vocabulary, which its integration declares. */
export type WorkflowCredentials = Record<string, string | undefined>;

/**
 * The stored config as the environment-variable names a handler reads it by.
 *
 * Every mapping an integration has is in its credential fields, which the
 * assembled catalog carries, so that is where this reads it -- the database
 * connection the engine's own Database Query action uses included, since it is a
 * catalog entry like any other.
 */
function mapIntegrationConfig(
  integrationType: string,
  config: IntegrationConfig
): WorkflowCredentials {
  return credentialsFromConfig(
    findIntegration(getExtensions().catalog, integrationType),
    config
  );
}

/**
 * Fetch credentials for an integration by ID
 *
 * @param integrationId - The ID of the integration to fetch credentials for
 * @returns WorkflowCredentials object with the integration's credentials
 */
export async function fetchCredentials(
  integrationId: string
): Promise<WorkflowCredentials> {
  const logger = credentialFetcherLogger.with({ integrationId });
  logger.debug("Fetching integration credentials");

  const integration = await getIntegrationById(integrationId);

  if (!integration) {
    logger.debug("Integration not found");
    return {};
  }

  logger.debug("Integration found", { integrationType: integration.type });

  const credentials = mapIntegrationConfig(
    integration.type,
    integration.config
  );

  logger.debug("Mapped integration credentials", {
    integrationType: integration.type,
    credentialKeys: Object.keys(credentials),
  });

  return credentials;
}
