/**
 * An integration's stored secrets, fetched by id at the moment a step needs them.
 *
 * A step is configured with an integration id and never with the secrets
 * themselves, so nothing that logs a step's input -- the run log, Inngest's own
 * observability -- has them to write down. The fetch happens inside the
 * handler's Effect and what it produces is thrown away with the step.
 */

import { Effect, Schema } from "effect";
import {
  credentialsFromConfig,
  findIntegration,
} from "@rova/shared/extensions/catalog";
import type { ExtensionCatalog } from "@rova/shared/extensions/catalog";
import type { IntegrationConfig } from "@rova/shared/types/integration";
import { ENCRYPTION_KEY_MISMATCH_MESSAGE } from "#src/backend/services/integrations/cipher";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import type { RovaRuntime } from "#src/backend/runtime";
import { getAppLogger } from "#src/backend/lib/logger";

const credentialFetcherLogger = getAppLogger("credentials", "fetcher");

/** A handler's own credential vocabulary, which its integration declares. */
export type WorkflowCredentials = Record<string, string | undefined>;

/**
 * The credential store could not be read, which is nothing about the run.
 *
 * It travels the step's error channel rather than the `StepResult` envelope, so
 * the step rejects rather than answering. The engine reads that rejection as the
 * node's failure, and the message names the store rather than anything the
 * builder configured.
 */
export class CredentialsUnavailable extends Schema.TaggedErrorClass<CredentialsUnavailable>()(
  "CredentialsUnavailable",
  {
    integrationId: Schema.String,
    message: Schema.String,
  }
) {}

const NO_CREDENTIALS: WorkflowCredentials = {};

/**
 * The stored config as the environment-variable names a handler reads it by.
 *
 * Every mapping an integration has is in its credential fields, which the
 * assembled catalog carries, so that is where this reads it.
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
 * Either way a credential read fails, as the one failure a node understands.
 *
 * The message is all that separates the two, so it is the only argument; the
 * tag itself reaches the log through the error value.
 */
const unavailable =
  (
    logger: ReturnType<typeof getAppLogger>,
    integrationId: string,
    message: string
  ) =>
  (error: unknown): Effect.Effect<never, CredentialsUnavailable> => {
    logger.error("Could not read the integration credentials", { error });
    return Effect.fail(new CredentialsUnavailable({ integrationId, message }));
  };

/**
 * An integration's credentials, or nothing when no row carries that id.
 *
 * A row that is missing answers with no credentials, because a step configured
 * with no integration is a step working against a public API. A store that
 * refuses the read answers with `CredentialsUnavailable`, which fails the node
 * that asked.
 */
export function fetchCredentials(
  catalog: ExtensionCatalog,
  runtime: RovaRuntime,
  integrationId: string
): Effect.Effect<WorkflowCredentials, CredentialsUnavailable> {
  return Effect.gen(function* () {
    const logger = credentialFetcherLogger.with({ integrationId });
    logger.debug("Fetching integration credentials");

    // A step's Effect asks for nothing but an HTTP client, so the app's services
    // are provided into the query here rather than by widening what a handler
    // requires. That is what keeps the step's own requirement channel empty, and
    // it is what lets a plugin's test run a step on a runtime carrying nothing.
    const services = yield* runtime.contextEffect;
    const integration = yield* Effect.provideContext(
      Effect.flatMap(IntegrationRepo, (repo) => repo.findById(integrationId)),
      services
    ).pipe(
      Effect.catchTags({
        DatabaseError: unavailable(
          logger,
          integrationId,
          `Could not read the credentials for integration "${integrationId}".`
        ),
        EncryptionKeyMismatch: unavailable(
          logger,
          integrationId,
          ENCRYPTION_KEY_MISMATCH_MESSAGE
        ),
      })
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
