/**
 * An integration's stored secrets, fetched by id at the moment a step needs them.
 *
 * A step is configured with an integration id and never with the secrets
 * themselves, so nothing that logs a step's input -- the run log, Inngest's own
 * observability -- has them to write down. The fetch happens inside the
 * handler's Effect and what it produces is thrown away with the step.
 */

import { Effect, Schema } from "effect";
import type { WfGraphRuntime } from "#src/backend/runtime";
import { getAppLogger } from "#src/backend/lib/logger";
import { resolveIntegrationCredentials } from "#src/backend/services/integrations/credential-resolver";
import { ENCRYPTION_KEY_MISMATCH_MESSAGE } from "#src/backend/services/integrations/cipher";

const credentialFetcherLogger = getAppLogger("credentials");

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
export class CredentialsUnavailable extends Schema.TaggedError<CredentialsUnavailable>()(
  "CredentialsUnavailable",
  {
    integrationId: Schema.String,
    message: Schema.String,
  }
) {}

/**
 * An integration's resolved credentials.
 *
 * A missing row, an unreadable store, or an OAuth grant that cannot become safe
 * to use answers with `CredentialsUnavailable`, which fails the node that asked.
 */
export function fetchCredentials(
  runtime: WfGraphRuntime,
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
    const resolved = yield* Effect.provideContext(
      resolveIntegrationCredentials(integrationId),
      services
    ).pipe(
      Effect.catch((failure) => {
        logger.error("Could not read the integration credentials", {
          failure: failure._tag,
        });
        return Effect.fail(
          new CredentialsUnavailable({
            integrationId,
            message:
              failure.error === ENCRYPTION_KEY_MISMATCH_MESSAGE
                ? ENCRYPTION_KEY_MISMATCH_MESSAGE
                : `Could not read the credentials for integration "${integrationId}".`,
          })
        );
      })
    );

    logger.debug("Mapped integration credentials", {
      integrationType: resolved.integrationType,
      credentialKeys: Object.keys(resolved.credentials),
    });

    return resolved.credentials;
  });
}
