/**
 * An integration's stored secrets, fetched by id at the moment a step needs them.
 *
 * A step is configured with an integration id and never with the secrets
 * themselves, so nothing that logs a step's input -- the run log, Inngest's own
 * observability -- has them to write down. The fetch happens inside the
 * handler's Effect and what it produces is thrown away with the step.
 */

import { Effect } from "effect";
import {
  credentialsFromConfig,
  findIntegration,
} from "@rova/shared/extensions/catalog";
import type { ExtensionCatalog } from "@rova/shared/extensions/catalog";
import type { IntegrationConfig } from "@rova/shared/types/integration";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import type { RovaRuntime } from "#src/backend/runtime";
import { getAppLogger } from "./logger";

const credentialFetcherLogger = getAppLogger("credentials", "fetcher");

/** A handler's own credential vocabulary, which its integration declares. */
export type WorkflowCredentials = Record<string, string | undefined>;

const NO_CREDENTIALS: WorkflowCredentials = {};

/**
 * The stored config as the environment-variable names a handler reads it by.
 *
 * Every mapping an integration has is in its credential fields, which the
 * assembled catalog carries, so that is where this reads it -- the database
 * connection the engine's own Database Query action uses included, since it is a
 * catalog entry like any other.
 */
function mapIntegrationConfig(
  catalog: ExtensionCatalog,
  integrationType: string,
  config: IntegrationConfig
): WorkflowCredentials {
  return credentialsFromConfig(
    findIntegration(catalog, integrationType),
    config
  );
}

/**
 * An integration's credentials, or nothing when no row carries that id.
 *
 * `Effect.promise`, not `tryPromise`: a credential store that rejects is a
 * defect, and a defect leaves the step by the throw path, where Inngest's
 * function-level retry runs the step again minutes later. That is the right
 * answer for a database that was briefly unreachable. A typed failure would end
 * the run on a condition that clears on its own.
 */
export function fetchCredentials(
  catalog: ExtensionCatalog,
  runtime: RovaRuntime,
  integrationId: string
): Effect.Effect<WorkflowCredentials> {
  return Effect.gen(function* () {
    const logger = credentialFetcherLogger.with({ integrationId });
    logger.debug("Fetching integration credentials");

    // A step's Effect asks for nothing but an HTTP client, so the repository is
    // reached by running the app's runtime rather than by widening what a
    // handler requires.
    const integration = yield* Effect.promise(() =>
      runtime.runPromise(
        Effect.flatMap(IntegrationRepo, (repo) => repo.findById(integrationId))
      )
    );

    if (!integration) {
      logger.debug("Integration not found");
      return NO_CREDENTIALS;
    }

    const credentials = mapIntegrationConfig(
      catalog,
      integration.type,
      integration.config
    );

    logger.debug("Mapped integration credentials", {
      integrationType: integration.type,
      credentialKeys: Object.keys(credentials),
    });

    return credentials;
  });
}
