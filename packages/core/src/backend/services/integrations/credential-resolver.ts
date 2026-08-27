import { DateTime, Effect, Result } from "effect";
import {
  credentialsFromConfig,
  findIntegration,
  type IntegrationMetadata,
} from "@wfgraph/shared/extensions/catalog";
import type { IntegrationConfig } from "@wfgraph/shared/types/integration";
import { getErrorMessage } from "@wfgraph/shared/utils";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { WfGraphAppContext } from "#src/backend/lib/effect/app-context";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  InternalFailure,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { ENCRYPTION_KEY_MISMATCH_MESSAGE } from "#src/backend/services/integrations/cipher";
import {
  normalizeOAuthGrant,
  oauthCredentialsAreDeclared,
  OAUTH_GRANT_CONFIG_KEY,
  readStoredOAuthGrant,
  serializeStoredOAuthGrant,
  type StoredOAuthGrant,
} from "#src/backend/services/integrations/oauth-grant";
import {
  oauthRegistrationContext,
  oauthUrlsFor,
} from "#src/backend/services/integrations/oauth-registration";
import {
  IntegrationRepo,
  type DecryptedIntegration,
} from "#src/backend/services/integrations/repo";
import type {
  IntegrationOAuth,
  OAuthClientRegistration,
} from "#src/backend/extensions/oauth";

/** Refresh before expiry so a credential stays valid during request startup. */
export const OAUTH_REFRESH_SKEW_MS = 60_000;

/** A refresh owner older than this has an uncertain provider outcome. */
export const OAUTH_REFRESH_CLAIM_STALE_MS = 2 * 60_000;

/** A race loser waits briefly for the owner, then lets its outer run retry. */
export const OAUTH_REFRESH_WAIT_MS = 500;

const OAUTH_REFRESH_POLL_MS = 25;
const INVALID_GRANT_MESSAGE = "Stored OAuth credentials are invalid.";
const REAUTHORIZE_MESSAGE =
  "OAuth credentials are unavailable. Reconnect the integration.";
const TEMPORARILY_UNAVAILABLE_MESSAGE =
  "OAuth credentials are temporarily unavailable.";

export type ResolvedIntegrationCredentials = {
  readonly integrationType: string;
  readonly credentials: Record<string, string | undefined>;
  readonly oauthCredentialKeys: readonly string[];
};

function internal(error: string): InternalFailure {
  return new InternalFailure({ error });
}

function readGrant(
  integration: DecryptedIntegration
): Effect.Effect<StoredOAuthGrant | null, InternalFailure> {
  if (!(OAUTH_GRANT_CONFIG_KEY in integration.config)) {
    return Effect.succeed(null);
  }

  const grant = readStoredOAuthGrant(integration.config);
  return grant
    ? Effect.succeed(grant)
    : Effect.fail(internal(INVALID_GRANT_MESSAGE));
}

function metadataFor(
  integration: DecryptedIntegration,
  extensions: Extensions["Service"]
): Effect.Effect<IntegrationMetadata, InvalidInput> {
  const metadata = findIntegration(extensions.catalog, integration.type);
  return metadata
    ? Effect.succeed(metadata)
    : Effect.fail(
        new InvalidInput({
          error: `Integration "${integration.type}" is unavailable.`,
        })
      );
}

function mapCredentials(
  integration: DecryptedIntegration,
  metadata: IntegrationMetadata,
  grant: StoredOAuthGrant | null
): ResolvedIntegrationCredentials {
  return {
    integrationType: integration.type,
    credentials: credentialsFromConfig(
      metadata,
      grant
        ? { ...integration.config, ...grant.credentials }
        : integration.config
    ),
    oauthCredentialKeys: grant ? Object.keys(grant.credentials).toSorted() : [],
  };
}

function refreshRequired(grant: StoredOAuthGrant, now: number): boolean {
  return (
    grant.tokens.expiresAt !== undefined &&
    DateTime.toEpochMillis(DateTime.makeUnsafe(grant.tokens.expiresAt)) <=
      now + OAUTH_REFRESH_SKEW_MS
  );
}

const readIntegration = Effect.fn("readIntegration")(function* (
  integrationId: string
) {
  const repo = yield* IntegrationRepo;
  const integration = yield* repo.findById(integrationId).pipe(
    Effect.catchTags({
      DatabaseError: ({ cause }) => internal(getErrorMessage(cause)),
      EncryptionKeyMismatch: () => internal(ENCRYPTION_KEY_MISMATCH_MESSAGE),
    })
  );
  if (!integration) {
    return yield* new NotFound({ error: "Integration not found" });
  }
  return integration;
});

const markReauthorization = Effect.fn("markOAuthReauthorization")(function* (
  integrationId: string,
  claimId: string,
  expectedRevision: number
) {
  const repo = yield* IntegrationRepo;
  const outcome = yield* Effect.result(
    repo.markReauthorizationRequired({
      integrationId,
      claimId,
      expectedRevision,
    })
  );
  return Result.isSuccess(outcome)
    ? outcome.success
    : { status: "unavailable" as const };
});

const awaitRefreshOwner = Effect.fn("awaitOAuthRefreshOwner")(function* (
  integrationId: string,
  metadata: IntegrationMetadata
) {
  const startedAt = DateTime.toEpochMillis(yield* DateTime.now);

  while (true) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (now - startedAt > OAUTH_REFRESH_WAIT_MS) {
      return yield* internal(TEMPORARILY_UNAVAILABLE_MESSAGE);
    }
    const integration = yield* readIntegration(integrationId);
    const grant = yield* readGrant(integration);

    if (!grant) {
      return mapCredentials(integration, metadata, null);
    }
    if (integration.refreshState === "reauthorization_required") {
      return yield* internal(REAUTHORIZE_MESSAGE);
    }
    if (integration.refreshState === "idle") {
      if (refreshRequired(grant, now)) {
        return yield* internal(TEMPORARILY_UNAVAILABLE_MESSAGE);
      }
      return mapCredentials(integration, metadata, grant);
    }

    const claimIsStale =
      !integration.refreshClaimedAt ||
      now - integration.refreshClaimedAt.getTime() >=
        OAUTH_REFRESH_CLAIM_STALE_MS;
    if (claimIsStale && integration.refreshClaimId) {
      const transition = yield* markReauthorization(
        integrationId,
        integration.refreshClaimId,
        integration.configRevision
      );
      if (transition.status === "transitioned") {
        return yield* internal(REAUTHORIZE_MESSAGE);
      }
      if (transition.status === "unavailable") {
        return yield* internal(TEMPORARILY_UNAVAILABLE_MESSAGE);
      }
      continue;
    }

    yield* Effect.sleep(OAUTH_REFRESH_POLL_MS);
  }
});

const resolveClaimedRefresh = Effect.fn("resolveClaimedOAuthRefresh")(
  function* (
    integration: DecryptedIntegration,
    metadata: IntegrationMetadata,
    grant: StoredOAuthGrant,
    claimId: string,
    oauth: IntegrationOAuth,
    client: OAuthClientRegistration
  ) {
    const repo = yield* IntegrationRepo;
    const logger = (yield* AppLogger).get("integrations").with({
      integrationId: integration.id,
      integrationType: integration.type,
    });
    const providerResult = yield* Effect.result(
      Effect.tryPromise({
        try: async () => await oauth.refresh({ client, grant }),
        catch: () => internal(REAUTHORIZE_MESSAGE),
      })
    );
    if (Result.isFailure(providerResult)) {
      yield* logger.error("OAuth provider token refresh failed", {
        operation: "token refresh",
        provider: integration.type,
        integrationId: integration.id,
      });
      yield* markReauthorization(
        integration.id,
        claimId,
        integration.configRevision
      );
      return yield* providerResult.failure;
    }

    const replacement = normalizeOAuthGrant(
      {
        ...providerResult.success,
        ...(grant.accountLabel ? { accountLabel: grant.accountLabel } : {}),
      },
      grant.connectedAt
    );
    // `providerResult.success` is spread whole above, so a refresh that narrows
    // the grant replaces the stored access label rather than keeping the old
    // one. `accountLabel` is carried forward on purpose; this must not be.
    if (
      !replacement ||
      !oauthCredentialsAreDeclared(metadata, replacement.credentials)
    ) {
      yield* logger.error(
        "OAuth provider token refresh returned an invalid grant",
        {
          operation: "token refresh",
          provider: integration.type,
          integrationId: integration.id,
        }
      );
      yield* markReauthorization(
        integration.id,
        claimId,
        integration.configRevision
      );
      return yield* internal(REAUTHORIZE_MESSAGE);
    }

    const replacementConfig: IntegrationConfig = {
      ...integration.config,
      [OAUTH_GRANT_CONFIG_KEY]: serializeStoredOAuthGrant(replacement),
    };
    const completion = yield* Effect.result(
      repo.completeRefresh({
        integrationId: integration.id,
        claimId,
        expectedRevision: integration.configRevision,
        config: replacementConfig,
      })
    );
    if (Result.isFailure(completion) || !completion.success) {
      yield* markReauthorization(
        integration.id,
        claimId,
        integration.configRevision
      );
      return yield* internal(TEMPORARILY_UNAVAILABLE_MESSAGE);
    }

    return mapCredentials(
      { ...integration, config: replacementConfig },
      metadata,
      replacement
    );
  }
);

/** Resolve one saved integration and refresh a rotating OAuth grant when needed. */
export const resolveIntegrationCredentials = Effect.fn(
  "resolveIntegrationCredentials"
)(function* (integrationId: string) {
  const integration = yield* readIntegration(integrationId);
  const extensions = yield* Extensions;
  const metadata = yield* metadataFor(integration, extensions);
  const grant = yield* readGrant(integration);

  if (!grant) {
    return mapCredentials(integration, metadata, null);
  }
  if (integration.refreshState === "reauthorization_required") {
    return yield* internal(REAUTHORIZE_MESSAGE);
  }
  if (integration.refreshState === "refreshing") {
    return yield* awaitRefreshOwner(integrationId, metadata);
  }
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (!refreshRequired(grant, now)) {
    return mapCredentials(integration, metadata, grant);
  }

  const repo = yield* IntegrationRepo;
  const claimId = globalThis.crypto.randomUUID();
  if (!grant.tokens.refreshToken) {
    const claim = yield* repo
      .claimRefresh({
        integrationId,
        claimId,
        expectedRevision: integration.configRevision,
      })
      .pipe(
        Effect.catchTag("DatabaseError", () =>
          internal(TEMPORARILY_UNAVAILABLE_MESSAGE)
        )
      );
    if (claim.status === "not_found") {
      return yield* new NotFound({ error: "Integration not found" });
    }
    if (claim.status === "lost") {
      return yield* awaitRefreshOwner(integrationId, metadata);
    }
    yield* markReauthorization(
      integrationId,
      claimId,
      integration.configRevision
    );
    return yield* internal(REAUTHORIZE_MESSAGE);
  }

  const context = yield* WfGraphAppContext;
  const urls = oauthUrlsFor(integration.type, context);
  const oauth = extensions.oauthFor(integration.type);
  if (!urls || !oauth) {
    return yield* internal(REAUTHORIZE_MESSAGE);
  }
  const claim = yield* repo
    .claimRefresh({
      integrationId,
      claimId,
      expectedRevision: integration.configRevision,
    })
    .pipe(
      Effect.catchTag("DatabaseError", () =>
        internal(TEMPORARILY_UNAVAILABLE_MESSAGE)
      )
    );
  if (claim.status === "not_found") {
    return yield* new NotFound({ error: "Integration not found" });
  }
  if (claim.status === "lost") {
    return yield* awaitRefreshOwner(integrationId, metadata);
  }

  const registration = yield* Effect.result(
    Effect.try({
      try: () => oauth.registerClient(oauthRegistrationContext(context, urls)),
      catch: () => internal(REAUTHORIZE_MESSAGE),
    })
  );
  if (Result.isFailure(registration)) {
    yield* Effect.result(
      repo.releaseRefreshClaim({
        integrationId,
        claimId,
        expectedRevision: integration.configRevision,
      })
    );
    return yield* registration.failure;
  }

  return yield* resolveClaimedRefresh(
    integration,
    metadata,
    grant,
    claimId,
    oauth,
    registration.success
  );
});
