import { Effect, Result } from "effect";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
import {
  Conflict,
  InternalFailure,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { Extensions } from "#src/backend/lib/effect/extensions";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import {
  normalizeOAuthGrant,
  oauthCredentialsAreDeclared,
  OAUTH_GRANT_CONFIG_KEY,
  readStoredOAuthGrant,
  removeStoredOAuthGrant,
  serializeStoredOAuthGrant,
} from "#src/backend/services/integrations/oauth-grant";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { findIntegration } from "@wfgraph/shared/extensions/catalog";
import { readJsonObject, type JsonObject } from "@wfgraph/shared/types/json";
import { WfGraphAppContext } from "#src/backend/lib/effect/app-context";
import {
  oauthRegistrationContext,
  oauthUrlsFor,
} from "#src/backend/services/integrations/oauth-registration";

const OAUTH_ATTEMPT_LIFETIME_SECONDS = 10 * 60;

export const oauthBindingCookieName = (state: string): string | null =>
  /^[A-Za-z0-9_-]{43}$/.test(state) ? `wfgraph_oauth_${state}` : null;

function randomOpaqueValue(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return toBase64Url(new Uint8Array(digest));
}

function missingPublicUrl() {
  return new InvalidInput({
    error: "OAuth requires createWfGraphApp to receive publicUrl.",
  });
}

const providerStep = <A>(input: {
  logger: EffectLogger;
  operation: string;
  integrationId?: string;
  integrationType: string;
  run: () => A | Promise<A>;
}): Effect.Effect<A, InternalFailure> =>
  Effect.tryPromise({
    try: async () => await input.run(),
    catch: () =>
      new InternalFailure({ error: "OAuth provider request failed" }),
  }).pipe(
    Effect.tapError(() =>
      input.logger.error(`OAuth provider ${input.operation} failed`, {
        operation: input.operation,
        provider: input.integrationType,
        ...(input.integrationId ? { integrationId: input.integrationId } : {}),
      })
    )
  );

function oauthUnavailable(type: string): NotFound {
  return new NotFound({
    error: `OAuth is unavailable for integration "${type}".`,
  });
}

function validateOAuthCredentials(
  type: string,
  credentials: Readonly<Record<string, string>>,
  extensions: ExtensionSet
): InvalidInput | null {
  const integration = findIntegration(extensions.catalog, type);
  if (!integration) {
    return new InvalidInput({ error: `Integration "${type}" is unavailable.` });
  }

  if (!oauthCredentialsAreDeclared(integration, credentials)) {
    return new InvalidInput({
      error: `OAuth returned a credential this integration does not declare.`,
    });
  }
  return null;
}

/** Begin an OAuth authorization code flow for one stored integration. */
export const startIntegrationOAuth = Effect.fn("startIntegrationOAuth")(
  function* (integrationId: string) {
    const context = yield* WfGraphAppContext;
    const urls = oauthUrlsFor("placeholder", context);
    if (!urls) {
      return yield* missingPublicUrl();
    }

    const repo = yield* IntegrationRepo;
    const extensions = yield* Extensions;
    const logger = (yield* AppLogger)
      .get("integrations")
      .with({ integrationId });
    const integration = yield* repo.findById(integrationId).pipe(
      Effect.catchTags({
        DatabaseError: () =>
          new InternalFailure({ error: "Failed to start OAuth" }),
        EncryptionKeyMismatch: () =>
          new InternalFailure({ error: "Failed to start OAuth" }),
      })
    );
    if (!integration) {
      return yield* new NotFound({ error: "Integration not found" });
    }

    const oauth = extensions.oauthFor(integration.type);
    if (!oauth) {
      return yield* oauthUnavailable(integration.type);
    }
    const routeUrls = oauthUrlsFor(integration.type, context)!;
    const client = yield* providerStep({
      logger,
      operation: "client registration",
      integrationId,
      integrationType: integration.type,
      run: () =>
        oauth.registerClient(oauthRegistrationContext(context, routeUrls)),
    });
    const state = randomOpaqueValue();
    const browserBinding = randomOpaqueValue();
    const stateHash = yield* Effect.promise(() => sha256Base64Url(state));
    const browserBindingHash = yield* Effect.promise(() =>
      sha256Base64Url(browserBinding)
    );
    const codeVerifier =
      oauth.pkce === "S256" ? randomOpaqueValue() : undefined;
    const codeChallenge = codeVerifier
      ? yield* Effect.promise(() => sha256Base64Url(codeVerifier))
      : undefined;

    yield* repo
      .createOAuthAuthorizationAttempt({
        stateHash,
        integrationId,
        expiresAt: new Date(Date.now() + OAUTH_ATTEMPT_LIFETIME_SECONDS * 1000),
        browserBindingHash,
        payload: {
          redirectUri: routeUrls.callbackUrl,
          configRevision: integration.configRevision,
          ...(codeVerifier ? { codeVerifier } : {}),
        },
      })
      .pipe(
        Effect.catchTag(
          "DatabaseError",
          () => new InternalFailure({ error: "Failed to start OAuth" })
        )
      );

    const authorizeUrl = yield* providerStep({
      logger,
      operation: "authorization URL creation",
      integrationId,
      integrationType: integration.type,
      run: () =>
        oauth.authorize({
          client,
          redirectUri: routeUrls.callbackUrl,
          state,
          ...(codeChallenge ? { codeChallenge } : {}),
        }),
    });

    return {
      authorizeUrl: authorizeUrl.toString(),
      // `randomOpaqueValue` always produces 43 base64url characters.
      cookieName: oauthBindingCookieName(state)!,
      browserBinding,
      maxAge: OAUTH_ATTEMPT_LIFETIME_SECONDS,
    };
  }
);

/** Consume an authorization attempt and persist the provider's normalized grant. */
export const completeIntegrationOAuth = Effect.fn("completeIntegrationOAuth")(
  function* (input: {
    state: string | undefined;
    browserBinding: string | undefined;
    code: string | undefined;
    providerError: string | undefined;
  }) {
    if (!input.state) {
      return yield* new InvalidInput({
        error: "OAuth authorization could not be verified.",
      });
    }
    const context = yield* WfGraphAppContext;
    if (!oauthUrlsFor("placeholder", context)) {
      return yield* missingPublicUrl();
    }

    const repo = yield* IntegrationRepo;
    const extensions = yield* Extensions;
    const logger = (yield* AppLogger).get("integrations");
    const stateHash = yield* Effect.promise(() =>
      sha256Base64Url(input.state!)
    );
    // An absent cookie deliberately hashes a different value, then consumes the
    // attempt. A callback URL copied into another browser cannot leave it usable.
    const browserBindingHash = yield* Effect.promise(() =>
      sha256Base64Url(input.browserBinding ?? "")
    );
    const attempt = yield* repo
      .consumeOAuthAuthorizationAttempt(stateHash, browserBindingHash)
      .pipe(
        Effect.catchTags({
          DatabaseError: () =>
            new InternalFailure({
              error: "OAuth authorization could not be verified.",
            }),
          EncryptionKeyMismatch: () =>
            new InternalFailure({
              error: "OAuth authorization could not be verified.",
            }),
        })
      );
    if (!attempt) {
      return yield* new InvalidInput({
        error: "OAuth authorization could not be verified.",
      });
    }
    if (input.providerError) {
      return yield* new InvalidInput({
        error: "OAuth authorization was declined by the provider.",
      });
    }
    if (!input.code) {
      return yield* new InvalidInput({
        error: "OAuth authorization did not return a code.",
      });
    }

    const integration = yield* repo.findById(attempt.integrationId).pipe(
      Effect.catchTags({
        DatabaseError: () =>
          new InternalFailure({ error: "Failed to complete OAuth" }),
        EncryptionKeyMismatch: () =>
          new InternalFailure({ error: "Failed to complete OAuth" }),
      })
    );
    if (!integration) {
      return yield* new NotFound({ error: "Integration not found" });
    }
    const oauth = extensions.oauthFor(integration.type);
    if (!oauth) {
      return yield* oauthUnavailable(integration.type);
    }
    const routeUrls = oauthUrlsFor(integration.type, context)!;
    const claimId = globalThis.crypto.randomUUID();
    const claimInput = {
      integrationId: integration.id,
      claimId,
      expectedRevision: attempt.payload.configRevision,
    };
    const claim = yield* repo
      .claimRefresh(claimInput)
      .pipe(
        Effect.catchTag(
          "DatabaseError",
          () => new InternalFailure({ error: "Failed to complete OAuth" })
        )
      );
    if (claim.status === "not_found") {
      return yield* new NotFound({ error: "Integration not found" });
    }
    if (claim.status === "lost") {
      return yield* new Conflict({
        error: "Integration configuration changed during OAuth callback.",
      });
    }

    const registration = yield* Effect.result(
      providerStep({
        logger,
        operation: "client registration",
        integrationId: integration.id,
        integrationType: integration.type,
        run: () =>
          oauth.registerClient(oauthRegistrationContext(context, routeUrls)),
      })
    );
    if (Result.isFailure(registration)) {
      yield* Effect.result(repo.releaseRefreshClaim(claimInput));
      return yield* registration.failure;
    }
    const client = registration.success;
    const exchange = yield* Effect.result(
      providerStep({
        logger,
        operation: "code exchange",
        integrationId: integration.id,
        integrationType: integration.type,
        run: () =>
          oauth.exchange({
            client,
            code: input.code!,
            redirectUri: attempt.payload.redirectUri,
            ...(attempt.payload.codeVerifier
              ? { codeVerifier: attempt.payload.codeVerifier }
              : {}),
          }),
      })
    );
    if (Result.isFailure(exchange)) {
      yield* Effect.result(repo.markReauthorizationRequired(claimInput));
      return yield* exchange.failure;
    }
    const grant = normalizeOAuthGrant(
      exchange.success,
      new Date().toISOString()
    );
    if (!grant) {
      yield* Effect.result(repo.markReauthorizationRequired(claimInput));
      return yield* new InvalidInput({
        error: "OAuth provider returned an invalid grant.",
      });
    }
    const credentialFailure = validateOAuthCredentials(
      integration.type,
      grant.credentials,
      extensions
    );
    if (credentialFailure) {
      yield* Effect.result(repo.markReauthorizationRequired(claimInput));
      return yield* credentialFailure;
    }

    const completion = yield* Effect.result(
      repo.completeRefresh({
        ...claimInput,
        config: {
          ...integration.config,
          [OAUTH_GRANT_CONFIG_KEY]: serializeStoredOAuthGrant(grant),
        },
      })
    );
    if (Result.isFailure(completion)) {
      // The provider may have issued credentials even when the database answer
      // was lost. Fence the stored connection for reauthorization and never
      // issue installation-wide cleanup that could revoke a newer grant.
      yield* Effect.result(repo.markReauthorizationRequired(claimInput));
      return yield* new InternalFailure({ error: "Failed to complete OAuth" });
    }
    if (!completion.success) {
      yield* Effect.result(repo.markReauthorizationRequired(claimInput));
      return yield* new Conflict({
        error: "Integration configuration changed during OAuth callback.",
      });
    }
    return undefined;
  }
);

/** Return a provider metadata document after proving it describes this endpoint. */
export const getOAuthClientMetadata = Effect.fn("getOAuthClientMetadata")(
  function* (integrationType: string) {
    const context = yield* WfGraphAppContext;
    const routeUrls = oauthUrlsFor(integrationType, context);
    if (!routeUrls) {
      return yield* missingPublicUrl();
    }
    const extensions = yield* Extensions;
    const oauth = extensions.oauthFor(integrationType);
    if (!oauth) {
      return yield* oauthUnavailable(integrationType);
    }
    const logger = (yield* AppLogger).get("integrations").with({
      integrationType,
    });
    const client = yield* providerStep({
      logger,
      operation: "client registration",
      integrationType,
      run: () =>
        oauth.registerClient(oauthRegistrationContext(context, routeUrls)),
    });
    if (!client.metadataDocument) {
      return yield* new NotFound({
        error: "OAuth client metadata is unavailable.",
      });
    }
    if (
      client.clientId !== routeUrls.metadataDocumentUrl ||
      hasClientSecret(client.metadataDocument) ||
      ("client_id" in client.metadataDocument &&
        client.metadataDocument.client_id !== routeUrls.metadataDocumentUrl)
    ) {
      return yield* new InternalFailure({
        error: "OAuth client metadata is invalid.",
      });
    }
    return client.metadataDocument;
  }
);

function hasClientSecret(document: JsonObject): boolean {
  for (const [key, value] of Object.entries(document)) {
    if (key === "client_secret" || key === "clientSecret") {
      return true;
    }
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        if (
          value.some((entry) => {
            const object = readJsonObject(entry);
            return object ? hasClientSecret(object) : false;
          })
        ) {
          return true;
        }
      } else if (hasClientSecret(value)) {
        return true;
      }
    }
  }
  return false;
}

/** Revoke the stored grant before returning control of its credentials to manual config. */
export const deleteIntegrationOAuth = Effect.fn("deleteIntegrationOAuth")(
  function* (integrationId: string) {
    const context = yield* WfGraphAppContext;
    const routeUrls = oauthUrlsFor("placeholder", context);
    if (!routeUrls) {
      return yield* missingPublicUrl();
    }
    const repo = yield* IntegrationRepo;
    const extensions = yield* Extensions;
    const logger = (yield* AppLogger)
      .get("integrations")
      .with({ integrationId });
    const integration = yield* repo.findById(integrationId).pipe(
      Effect.catchTags({
        DatabaseError: () =>
          new InternalFailure({ error: "Failed to revoke OAuth" }),
        EncryptionKeyMismatch: () =>
          new InternalFailure({ error: "Failed to revoke OAuth" }),
      })
    );
    if (!integration)
      return yield* new NotFound({ error: "Integration not found" });
    const oauth = extensions.oauthFor(integration.type);
    if (!oauth) return yield* oauthUnavailable(integration.type);
    const grant = readStoredOAuthGrant(integration.config);
    if (!grant) {
      return yield* new NotFound({ error: "OAuth is not connected." });
    }
    if (integration.refreshState === "reauthorization_required") {
      return yield* new Conflict({
        error:
          "OAuth connection state is uncertain. Reconnect the integration.",
      });
    }

    const claimId = globalThis.crypto.randomUUID();
    const claimInput = {
      integrationId,
      claimId,
      expectedRevision: integration.configRevision,
    };
    const claim = yield* repo
      .claimRefresh(claimInput)
      .pipe(
        Effect.catchTag(
          "DatabaseError",
          () => new InternalFailure({ error: "Failed to revoke OAuth" })
        )
      );
    if (claim.status === "not_found") {
      return yield* new NotFound({ error: "Integration not found" });
    }
    if (claim.status === "lost") {
      return yield* new Conflict({
        error: "Integration configuration changed during OAuth disconnect.",
      });
    }

    const urls = oauthUrlsFor(integration.type, context)!;
    const registration = yield* Effect.result(
      providerStep({
        logger,
        operation: "client registration",
        integrationId,
        integrationType: integration.type,
        run: () =>
          oauth.registerClient(oauthRegistrationContext(context, urls)),
      })
    );
    if (Result.isFailure(registration)) {
      yield* Effect.result(repo.releaseRefreshClaim(claimInput));
      return yield* registration.failure;
    }

    const revocation = yield* Effect.result(
      providerStep({
        logger,
        operation: "revocation",
        integrationId,
        integrationType: integration.type,
        run: () => oauth.revoke({ client: registration.success, grant }),
      })
    );
    if (Result.isFailure(revocation)) {
      // A rejected adapter call does not confirm that revocation took effect.
      // Preserve the stored grant and release ownership so the caller can make
      // the existing connection usable or retry the explicit disconnect.
      yield* Effect.result(repo.releaseRefreshClaim(claimInput));
      return yield* revocation.failure;
    }

    const completion = yield* Effect.result(
      repo.completeRefresh({
        ...claimInput,
        config: removeStoredOAuthGrant(integration.config),
      })
    );
    if (Result.isFailure(completion)) {
      // Revocation succeeded, while the database outcome is unknown. Retain
      // config and fence credential use; repeating revocation could target a
      // newer installation grant.
      yield* Effect.result(repo.markReauthorizationRequired(claimInput));
      return yield* new InternalFailure({ error: "Failed to revoke OAuth" });
    }
    if (!completion.success) {
      yield* Effect.result(repo.markReauthorizationRequired(claimInput));
      return yield* new Conflict({
        error: "Integration configuration changed during OAuth disconnect.",
      });
    }
    return { success: true as const };
  }
);
