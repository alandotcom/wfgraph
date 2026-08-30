/**
 * Connection-addressed webhook intake: verify, receive, send.
 *
 * Path params name the integration type and the Connection. Host `auth` does
 * not run; the vendor signature is the credential. The raw body is what
 * `verify` sees, because Svix and every HMAC scheme are sensitive to a single
 * byte of re-serialization.
 */

import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { statedSeamFailureHandlers } from "#src/backend/lib/effect/internal-failure";
import {
  InternalFailure,
  InvalidInput,
  NotFound,
  Unauthorized,
} from "#src/backend/lib/effect/failures";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { isWebhookHandshake } from "#src/backend/extensions/integration-webhook";
import {
  credentialsFromConfig,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { getErrorMessage } from "@wfgraph/shared/utils";

const webhookLogger = Effect.map(AppLogger, (appLogger) =>
  appLogger.get("webhook")
);

export const receiveWebhook = Effect.fn("receiveWebhook")(
  function* (input: {
    type: string;
    connectionId: string;
    rawBody: string;
    headers: Headers;
  }) {
    const extensions = yield* Extensions;
    const repo = yield* IntegrationRepo;
    const inngest = yield* InngestClient;
    const logger = (yield* webhookLogger).with({
      webhook: {
        type: input.type,
        connectionId: input.connectionId,
        bytes: input.rawBody.length,
      },
    });

    const webhook = extensions.webhookFor(input.type);
    if (!webhook) {
      return yield* new NotFound({ error: "Not found" });
    }

    const connection = yield* repo.findById(input.connectionId);
    if (!connection || connection.type !== input.type) {
      return yield* new NotFound({ error: "Not found" });
    }

    const credentials = credentialsFromConfig(
      findIntegration(extensions.catalog, connection.type),
      connection.config
    );

    yield* webhook
      .verify({
        rawBody: input.rawBody,
        headers: input.headers,
        credentials,
      })
      .pipe(
        Effect.mapError(
          (rejected) => new Unauthorized({ error: rejected.error })
        )
      );

    const parsed = yield* Effect.try({
      try: () => JSON.parse(input.rawBody) as unknown,
      catch: () =>
        new InvalidInput({
          error: "Request body must be valid JSON",
        }),
    });

    const body = readJsonObject(parsed);
    if (!body) {
      return yield* new InvalidInput({
        error: "Request body must be a JSON object",
      });
    }

    const received = webhook.receive(body, input.headers);
    if (received === undefined) {
      yield* logger.info("Ignored a webhook payload");
      return { kind: "ignored" as const };
    }

    if (isWebhookHandshake(received)) {
      return {
        kind: "handshake" as const,
        response: received.handshake,
      };
    }

    yield* inngest.sendCatalogEvent({
      name: received.event,
      data: received.data,
      connectionId: input.connectionId,
      id: received.id,
    });

    yield* logger.info("Forwarded a webhook as an Event", {
      webhook: {
        type: input.type,
        connectionId: input.connectionId,
        event: received.event,
        bytes: input.rawBody.length,
      },
    });

    return { kind: "sent" as const, event: received.event };
  },
  (effect) =>
    effect.pipe(
      Effect.catchTags({
        ...statedSeamFailureHandlers(
          webhookLogger,
          "Failed to receive webhook",
          "Could not receive this webhook"
        ),
        EncryptionKeyMismatch: (failure) =>
          Effect.gen(function* () {
            const logger = yield* webhookLogger;
            yield* logger.error(
              `Failed to receive webhook: ${getErrorMessage(failure.cause)}`,
              { error: failure.cause }
            );
            return yield* new InternalFailure({
              error: "Could not receive this webhook",
              cause: failure.cause,
            });
          }),
      })
    )
);
