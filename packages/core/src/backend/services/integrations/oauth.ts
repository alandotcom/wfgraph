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
import {
  IntegrationRepo,
  type OAuthAuthorizationAttemptPayload,
} from "#src/backend/services/integrations/repo";
import { findIntegration } from "@wfgraph/shared/extensions/catalog";
import { WfGraphAppContext } from "#src/backend/lib/effect/app-context";
import {
  oauthRegistrationContext,
  oauthUrlsFor,
} from "#src/backend/services/integrations/oauth-registration";
import { decodePublicOAuthClientMetadata } from "#src/backend/extensions/oauth";
import { generateId } from "@wfgraph/shared/utils/id";
import type { IntegrationConfig } from "@wfgraph/shared/types/integration";

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

export type StartIntegrationOAuthInput =
  | { mode: "reconnect"; integrationId: string }
  | {
      mode: "create";
      name: string;
      type: string;
      config: IntegrationConfig;
    };

/** Begin a create or reconnect authorization code flow. */
export const startIntegrationOAuth = Effect.fn("startIntegrationOAuth")(
  function* (input: StartIntegrationOAuthInput) {
    const context = yield* WfGraphAppContext;
    if (!context.oauth) {
      return yield* missingPublicUrl();
    }

    const repo = yield* IntegrationRepo;
    const extensions = yield* Extensions;
    let integrationId: string;
    let integrationType: string;
    let payload: OAuthAuthorizationAttemptPayload;

    if (input.mode === "reconnect") {
      const integration = yield* repo.findById(input.integrationId).pipe(
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
      integrationId = integration.id;
      integrationType = integration.type;
      payload = {
        kind: "reconnect",
        redirectUri: context.oauth.callbackUrl,
        configRevision: integration.configRevision,
      };
    } else {
      if (OAUTH_GRANT_CONFIG_KEY in input.config) {
        return yield* new InvalidInput({
          error: "The OAuth grant config key is reserved.",
        });
      }
      if (!findIntegration(extensions.catalog, input.type)) {
        return yield* new InvalidInput({
          error: `Integration "${input.type}" is unavailable.`,
        });
      }
      integrationId = generateId();
      integrationType = input.type;
      payload = {
        kind: "create",
        integrationId,
        configRevision: 0,
        name: input.name,
        type: input.type,
        config: input.config,
        redirectUri: context.oauth.callbackUrl,
      };
    }

    const oauth = extensions.oauthFor(integrationType);
    if (!oauth) {
      return yield* oauthUnavailable(integrationType);
    }
    const routeUrls = oauthUrlsFor(integrationType, context);
    if (!routeUrls) return yield* missingPublicUrl();
    const logger = (yield* AppLogger)
      .get("integrations")
      .with({ integrationId });
    const client = yield* providerStep({
      logger,
      operation: "client registration",
      integrationId,
      integrationType,
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

    const authorizeUrl = yield* providerStep({
      logger,
      operation: "authorization URL creation",
      integrationId,
      integrationType,
      run: async () => {
        const authorizationInput = {
          client,
          redirectUri: routeUrls.callbackUrl,
          state,
        };
        if (oauth.pkce === "S256") {
          if (!codeVerifier) throw new Error("OAuth PKCE verifier is missing");
          const codeChallenge = await sha256Base64Url(codeVerifier);
          return oauth.authorize({ ...authorizationInput, codeChallenge });
        }
        return oauth.authorize(authorizationInput);
      },
    });

    const expiresAt = new Date(
      Date.now() + OAUTH_ATTEMPT_LIFETIME_SECONDS * 1000
    );
    const authorizationAttempt =
      payload.kind === "create"
        ? {
            stateHash,
            integrationId: null,
            expiresAt,
            browserBindingHash,
            payload: {
              ...payload,
              ...(codeVerifier ? { codeVerifier } : {}),
            },
          }
        : {
            stateHash,
            integrationId,
            expiresAt,
            browserBindingHash,
            payload: {
              ...payload,
              ...(codeVerifier ? { codeVerifier } : {}),
            },
          };
    yield* repo
      .createOAuthAuthorizationAttempt(authorizationAttempt)
      .pipe(
        Effect.catchTag(
          "DatabaseError",
          () => new InternalFailure({ error: "Failed to start OAuth" })
        )
      );

    return {
      attemptId: state,
      authorizeUrl: authorizeUrl.toString(),
      // `randomOpaqueValue` always produces 43 base64url characters.
      cookieName: `wfgraph_oauth_${state}`,
      browserBinding,
      maxAge: OAUTH_ATTEMPT_LIFETIME_SECONDS,
    };
  }
);

/** Read a browser-bound attempt without exposing its internal processing phase. */
export const readIntegrationOAuthAttemptStatus = Effect.fn(
  "readIntegrationOAuthAttemptStatus"
)(function* (input: { attemptId: string; browserBinding: string }) {
  const repo = yield* IntegrationRepo;
  const stateHash = yield* Effect.promise(() =>
    sha256Base64Url(input.attemptId)
  );
  const browserBindingHash = yield* Effect.promise(() =>
    sha256Base64Url(input.browserBinding)
  );
  const status = yield* repo
    .readOAuthAuthorizationAttemptStatus({ stateHash, browserBindingHash })
    .pipe(
      Effect.catchTag(
        "DatabaseError",
        () => new InternalFailure({ error: "Failed to read OAuth status" })
      )
    );
  if (!status) {
    return yield* new NotFound({ error: "OAuth attempt not found" });
  }
  return status.status === "processing"
    ? { status: "pending" as const }
    : status;
});

/** Claim an authorization attempt and persist the provider's normalized grant. */
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
    const state = input.state;
    const context = yield* WfGraphAppContext;
    if (!context.oauth) {
      return yield* missingPublicUrl();
    }

    const repo = yield* IntegrationRepo;
    const extensions = yield* Extensions;
    const logger = (yield* AppLogger).get("integrations");
    const stateHash = yield* Effect.promise(() => sha256Base64Url(state));
    // An absent cookie deliberately hashes a different value. A callback URL
    // copied into another browser burns the pending attempt without opening it.
    const browserBindingHash = yield* Effect.promise(() =>
      sha256Base64Url(input.browserBinding ?? "")
    );
    const terminalExpiry = () =>
      new Date(Date.now() + OAUTH_ATTEMPT_LIFETIME_SECONDS * 1000);
    const failAttempt = () =>
      Effect.result(
        repo.failOAuthAuthorizationAttempt({
          stateHash,
          expiresAt: terminalExpiry(),
        })
      );
    const claimedAttempt = yield* Effect.result(
      repo.claimOAuthAuthorizationAttempt({
        stateHash,
        browserBindingHash,
        expiresAt: terminalExpiry(),
      })
    );
    if (Result.isFailure(claimedAttempt)) {
      yield* failAttempt();
      return yield* new InternalFailure({
        error: "OAuth authorization could not be verified.",
      });
    }
    const attempt = claimedAttempt.success;
    if (!attempt) {
      yield* failAttempt();
      return yield* new InvalidInput({
        error: "OAuth authorization could not be verified.",
      });
    }
    if (input.providerError) {
      yield* failAttempt();
      return yield* new InvalidInput({
        error: "OAuth authorization was declined by the provider.",
      });
    }
    if (!input.code) {
      yield* failAttempt();
      return yield* new InvalidInput({
        error: "OAuth authorization did not return a code.",
      });
    }

    if (attempt.payload.kind === "create") {
      const pending = attempt.payload;
      const oauth = extensions.oauthFor(pending.type);
      if (!oauth) {
        yield* failAttempt();
        return yield* oauthUnavailable(pending.type);
      }
      const routeUrls = oauthUrlsFor(pending.type, context);
      if (!routeUrls) {
        yield* failAttempt();
        return yield* missingPublicUrl();
      }
      const codeVerifier = pending.codeVerifier;
      if (oauth.pkce === "S256" && !codeVerifier) {
        yield* failAttempt();
        return yield* new InternalFailure({
          error: "OAuth authorization could not be verified.",
        });
      }
      const createLogger = logger.with({
        integrationId: pending.integrationId,
      });
      const registration = yield* Effect.result(
        providerStep({
          logger: createLogger,
          operation: "client registration",
          integrationId: pending.integrationId,
          integrationType: pending.type,
          run: () =>
            oauth.registerClient(oauthRegistrationContext(context, routeUrls)),
        })
      );
      if (Result.isFailure(registration)) {
        yield* failAttempt();
        return yield* registration.failure;
      }
      const client = registration.success;
      const exchangeInput = {
        client,
        code: input.code,
        redirectUri: pending.redirectUri,
      };
      const exchange = yield* Effect.result(
        providerStep({
          logger: createLogger,
          operation: "code exchange",
          integrationId: pending.integrationId,
          integrationType: pending.type,
          run: () => {
            if (oauth.pkce === "S256") {
              if (!codeVerifier) {
                throw new Error("OAuth PKCE verifier is missing");
              }
              return oauth.exchange({
                ...exchangeInput,
                codeVerifier,
              });
            }
            return oauth.exchange(exchangeInput);
          },
        })
      );
      if (Result.isFailure(exchange)) {
        yield* failAttempt();
        return yield* exchange.failure;
      }
      const issued = exchange.success;
      const grant = normalizeOAuthGrant(issued, new Date().toISOString());
      if (!grant) {
        yield* Effect.result(
          providerStep({
            logger: createLogger,
            operation: "cleanup revocation",
            integrationId: pending.integrationId,
            integrationType: pending.type,
            run: () => oauth.revoke({ client, grant: issued }),
          })
        );
        yield* failAttempt();
        return yield* new InvalidInput({
          error: "OAuth provider returned an invalid grant.",
        });
      }
      const revokeIssuedGrant = () =>
        providerStep({
          logger: createLogger,
          operation: "cleanup revocation",
          integrationId: pending.integrationId,
          integrationType: pending.type,
          run: () => oauth.revoke({ client, grant }),
        });
      const credentialFailure = validateOAuthCredentials(
        pending.type,
        grant.credentials,
        extensions
      );
      if (credentialFailure) {
        yield* Effect.result(revokeIssuedGrant());
        yield* failAttempt();
        return yield* credentialFailure;
      }

      const insertion = yield* Effect.result(
        repo.completeOAuthCreateAttempt({
          stateHash,
          integrationId: pending.integrationId,
          name: pending.name,
          type: pending.type,
          expiresAt: terminalExpiry(),
          config: {
            ...pending.config,
            [OAUTH_GRANT_CONFIG_KEY]: serializeStoredOAuthGrant(grant),
          },
        })
      );
      if (Result.isFailure(insertion)) {
        const resolvedStatus = yield* Effect.result(
          repo.readOAuthAuthorizationAttemptStatus({
            stateHash,
            browserBindingHash,
          })
        );
        if (
          Result.isSuccess(resolvedStatus) &&
          resolvedStatus.success?.status === "succeeded"
        ) {
          return undefined;
        }
        if (Result.isSuccess(resolvedStatus)) {
          yield* Effect.result(revokeIssuedGrant());
          yield* failAttempt();
        }
        return yield* new InternalFailure({
          error: "Failed to complete OAuth",
        });
      }
      if (!insertion.success) {
        yield* Effect.result(revokeIssuedGrant());
        yield* failAttempt();
        return yield* new Conflict({
          error: "OAuth authorization attempt is no longer active.",
        });
      }
      return undefined;
    }
    if (attempt.integrationId === null) {
      yield* failAttempt();
      return yield* new InvalidInput({
        error: "OAuth authorization could not be verified.",
      });
    }

    const found = yield* Effect.result(repo.findById(attempt.integrationId));
    if (Result.isFailure(found)) {
      yield* failAttempt();
      return yield* new InternalFailure({ error: "Failed to complete OAuth" });
    }
    const integration = found.success;
    if (!integration) {
      yield* failAttempt();
      return yield* new NotFound({ error: "Integration not found" });
    }
    const oauth = extensions.oauthFor(integration.type);
    if (!oauth) {
      yield* failAttempt();
      return yield* oauthUnavailable(integration.type);
    }
    const routeUrls = oauthUrlsFor(integration.type, context);
    if (!routeUrls) {
      yield* failAttempt();
      return yield* missingPublicUrl();
    }
    const codeVerifier = attempt.payload.codeVerifier;
    if (oauth.pkce === "S256" && !codeVerifier) {
      yield* failAttempt();
      return yield* new InternalFailure({
        error: "OAuth authorization could not be verified.",
      });
    }
    const claimInput = {
      integrationId: integration.id,
      claimId: stateHash,
      expectedRevision: attempt.payload.configRevision,
    };
    const claimed = yield* Effect.result(repo.claimRefresh(claimInput));
    if (Result.isFailure(claimed)) {
      yield* failAttempt();
      return yield* new InternalFailure({ error: "Failed to complete OAuth" });
    }
    const claim = claimed.success;
    if (claim.status === "not_found") {
      yield* failAttempt();
      return yield* new NotFound({ error: "Integration not found" });
    }
    if (claim.status === "lost") {
      yield* failAttempt();
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
      yield* failAttempt();
      return yield* registration.failure;
    }
    const client = registration.success;
    const exchangeInput = {
      client,
      code: input.code,
      redirectUri: attempt.payload.redirectUri,
    };
    const exchange = yield* Effect.result(
      providerStep({
        logger,
        operation: "code exchange",
        integrationId: integration.id,
        integrationType: integration.type,
        run: () => {
          if (oauth.pkce === "S256") {
            if (!codeVerifier) {
              throw new Error("OAuth PKCE verifier is missing");
            }
            return oauth.exchange({
              ...exchangeInput,
              codeVerifier,
            });
          }
          return oauth.exchange(exchangeInput);
        },
      })
    );
    if (Result.isFailure(exchange)) {
      yield* Effect.result(repo.markReauthorizationRequired(claimInput));
      yield* failAttempt();
      return yield* exchange.failure;
    }
    const grant = normalizeOAuthGrant(
      exchange.success,
      new Date().toISOString()
    );
    if (!grant) {
      yield* Effect.result(repo.markReauthorizationRequired(claimInput));
      yield* failAttempt();
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
      yield* failAttempt();
      return yield* credentialFailure;
    }

    const completion = yield* Effect.result(
      repo.completeOAuthReconnectAttempt({
        stateHash,
        integrationId: integration.id,
        expectedRevision: attempt.payload.configRevision,
        expiresAt: terminalExpiry(),
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
      yield* failAttempt();
      return yield* new InternalFailure({ error: "Failed to complete OAuth" });
    }
    if (!completion.success) {
      yield* Effect.result(repo.markReauthorizationRequired(claimInput));
      yield* failAttempt();
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
    const metadata = decodePublicOAuthClientMetadata(client.metadataDocument);
    if (
      client.clientId !== routeUrls.metadataDocumentUrl ||
      Result.isFailure(metadata) ||
      metadata.success.client_id !== routeUrls.metadataDocumentUrl ||
      metadata.success.redirect_uris?.length !== 1 ||
      metadata.success.redirect_uris[0] !== routeUrls.callbackUrl
    ) {
      return yield* new InternalFailure({
        error: "OAuth client metadata is invalid.",
      });
    }
    return metadata.success;
  }
);

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
