import { Effect, Result } from "effect";
import { mapValues, omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
import { internalFailure } from "#src/backend/lib/effect/internal-failure";
import {
  Conflict,
  InternalFailure,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  credentialsFromConfig,
  type ExtensionCatalog,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";
import type {
  IntegrationConfig,
  IntegrationRefreshState,
} from "@wfgraph/shared/types/integration";
import { isBlank } from "@wfgraph/shared/types/string";
import { getErrorMessage } from "@wfgraph/shared/utils";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { ENCRYPTION_KEY_MISMATCH_MESSAGE } from "#src/backend/services/integrations/cipher";
import {
  connectionDefaultsForBrowser,
  createSecretConfigKeyTest,
  maskIntegrationConfig,
  SECRET_MASK,
} from "#src/backend/services/integrations/integration-config-masking";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import {
  attemptVendorStep,
  describeUnavailableIntegration,
  type DescribeVendorFailure,
} from "#src/backend/services/integrations/vendor-call";
import {
  manuallyConfiguredKeys,
  OAUTH_GRANT_CONFIG_KEY,
  readStoredOAuthGrant,
} from "#src/backend/services/integrations/oauth-grant";
import { resolveIntegrationCredentials } from "#src/backend/services/integrations/credential-resolver";
import { deleteIntegrationOAuth } from "#src/backend/services/integrations/oauth";

type IntegrationSummary = {
  id: string;
  name: string;
  type: string;
  isManaged?: boolean;
  createdAt: string;
  updatedAt: string;
  configuredKeys: readonly string[];
  /**
   * The stored values a config field named with `connectionDefaultKey`, for the
   * editor to draw as that field's placeholder. Never a secret.
   */
  connectionDefaults: Record<string, string>;
  oauth?: {
    status: "connected" | "reauthorization_required";
    connectedAt: string;
    accountLabel?: string;
    credentialKeys: readonly string[];
    grantedAccessLabel?: string;
  };
};

type IntegrationWithConfig = IntegrationSummary & {
  config: IntegrationConfig;
};

/** The contract answers a connection test with this. */
type IntegrationTestResponse = {
  status: "success" | "error";
  message: string;
};

/** The contract answers a delete with this and nothing else. */
type IntegrationDeleted = { success: true };

// Reaching here means the integration is in the catalog and declares no `test`,
// which is a definition that offers no connection test rather than a setup
// mistake. The credentials dialog draws the button off `hasTest`, so this answers
// the request that arrives anyway.
const MISSING_TEST_MESSAGE =
  "Connection testing is unavailable for this integration, because it declares no test.";

function hasReservedOAuthGrant(config: IntegrationConfig | undefined): boolean {
  return config !== undefined && OAUTH_GRANT_CONFIG_KEY in config;
}

function mergeIntegrationConfig(
  catalog: ExtensionCatalog,
  type: string,
  currentConfig: IntegrationConfig,
  updates?: IntegrationConfig
): IntegrationConfig {
  if (!updates) {
    return currentConfig;
  }

  const isSecretKey = createSecretConfigKeyTest(catalog, type);
  const sanitizedUpdates = omitBy(
    updates,
    (value, key) =>
      value === undefined ||
      (typeof key === "string" &&
        isSecretKey(key) &&
        (value === SECRET_MASK ||
          (typeof value === "string" && isBlank(value))))
  );

  return {
    ...currentConfig,
    ...sanitizedUpdates,
  };
}

function oauthCredentialKeys(config: IntegrationConfig): readonly string[] {
  const grant = readStoredOAuthGrant(config);
  return grant ? Object.keys(grant.credentials).toSorted() : [];
}

function rejectsOAuthCredentialOverride(
  config: IntegrationConfig | undefined,
  credentialKeys: readonly string[]
): boolean {
  if (!config || credentialKeys.length === 0) {
    return false;
  }

  const oauthKeys = new Set(credentialKeys);
  return Object.keys(config).some((key) => oauthKeys.has(key));
}

function oauthCredentialOverrideFailure(): InvalidInput {
  return new InvalidInput({
    error:
      "OAuth-managed credentials cannot be changed while OAuth is connected. Disconnect OAuth first.",
  });
}

function toIntegrationSummary(
  catalog: ExtensionCatalog,
  input: {
    id: string;
    name: string;
    type: string;
    isManaged?: boolean | null | undefined;
    config: IntegrationConfig;
    refreshState: IntegrationRefreshState;
    createdAt: Date;
    updatedAt: Date;
  }
): IntegrationSummary {
  const grant = readStoredOAuthGrant(input.config);
  const configuredKeys = manuallyConfiguredKeys(
    findIntegration(catalog, input.type),
    input.config
  );
  return omitUndefined({
    id: input.id,
    name: input.name,
    type: input.type,
    isManaged: input.isManaged ?? false,
    createdAt: input.createdAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
    configuredKeys,
    connectionDefaults: connectionDefaultsForBrowser(
      catalog,
      input.type,
      input.config
    ),
    oauth: grant
      ? omitUndefined({
          status:
            input.refreshState === "reauthorization_required"
              ? ("reauthorization_required" as const)
              : ("connected" as const),
          connectedAt: grant.connectedAt,
          accountLabel: grant.accountLabel,
          credentialKeys: Object.keys(grant.credentials).toSorted(),
          grantedAccessLabel: grant.grantedAccessLabel,
        })
      : undefined,
  });
}

function toIntegrationWithConfig(
  catalog: ExtensionCatalog,
  input: {
    id: string;
    name: string;
    type: string;
    config: IntegrationConfig;
    isManaged?: boolean | null | undefined;
    refreshState: IntegrationRefreshState;
    createdAt: Date;
    updatedAt: Date;
  }
): IntegrationWithConfig {
  const managedKeys = new Set(oauthCredentialKeys(input.config));
  return {
    ...toIntegrationSummary(catalog, input),
    config: maskIntegrationConfig(
      catalog,
      input.type,
      omitBy(
        input.config,
        (_, key) => key === OAUTH_GRANT_CONFIG_KEY || managedKeys.has(key)
      )
    ),
  };
}

/**
 * Both ways a read of this repository fails, for `Effect.catchTags`.
 *
 * Only the query failure's wording changes per endpoint, which is why it is the
 * one argument. `postIntegrationTest` spells its pair out instead, because it
 * answers a query failure differently from every other read.
 */
const onReadFailure = (logger: EffectLogger, databaseMessage: string) => ({
  DatabaseError: internalFailure(logger, databaseMessage),
  EncryptionKeyMismatch: internalFailure(
    logger,
    ENCRYPTION_KEY_MISMATCH_MESSAGE
  ),
});

/**
 * The two endpoints word their log line differently, and both wordings predate
 * the migration, so `attemptVendorStep` takes the wording rather than fixing it.
 */
const describeTestFailure: DescribeVendorFailure = (cause) =>
  `Failed to test integration connection: ${getErrorMessage(cause)}`;

const describeSavedTestFailure: DescribeVendorFailure = () =>
  "Failed to test saved integration connection";

/**
 * Does this integration type connect with these declared credentials?
 *
 * The saved endpoint resolves and refreshes its credential map first. The
 * unsaved endpoint maps the config that the caller supplied directly, so it
 * names no OAuth keys: nothing has been granted while the form is still open.
 */
const runConnectionTest = Effect.fn("runConnectionTest")(function* (
  callerLogger: EffectLogger,
  describe: DescribeVendorFailure,
  type: string,
  credentials: Record<string, string | undefined>,
  grantedCredentialKeys: readonly string[]
) {
  const logger = callerLogger.with({ type });
  const attempt = attemptVendorStep(logger, describe);

  const extensions = yield* Extensions;
  const integration = findIntegration(extensions.catalog, type);

  if (!integration) {
    const error = describeUnavailableIntegration(extensions.catalog, type);
    yield* logger.warn(error);
    return yield* new InvalidInput({ error });
  }

  const loadTest = extensions.connectionTestFor(type);
  if (!loadTest) {
    yield* logger.warn(MISSING_TEST_MESSAGE);
    return yield* new InvalidInput({ error: MISSING_TEST_MESSAGE });
  }

  // The loader reaches for a vendor module, which is a throw the same `attempt`
  // wraps as the vendor call below.
  const testFn = yield* attempt(() => loadTest());

  yield* logger.info("Testing integration credentials", {
    credentialKeys: Object.keys(credentials),
    // Which credentials arrived and which came through empty, without the
    // values themselves ever reaching a log.
    credentialPresence: mapValues(credentials, (value) =>
      value ? "present" : "empty"
    ),
  });

  const testResult = yield* attempt(() =>
    testFn(credentials, { oauthCredentialKeys: grantedCredentialKeys })
  );

  if (!testResult.success) {
    yield* logger.warn(
      `Integration test returned failure: ${testResult.error}`,
      {
        error: testResult.error,
        details: testResult.details,
      }
    );
  }

  const answer: IntegrationTestResponse = testResult.success
    ? { status: "success", message: "Connection successful" }
    : { status: "error", message: testResult.error };
  return answer;
});

export const getIntegrations = Effect.fn("getIntegrations")(function* (
  type?: string
) {
  const repo = yield* IntegrationRepo;
  const logger = (yield* AppLogger)
    .get("integrations")
    .with({ type: type ?? null });
  const { catalog } = yield* Extensions;

  const integrations = yield* repo
    .listByType(type)
    .pipe(
      Effect.catchTags(onReadFailure(logger, "Failed to get integrations"))
    );

  return integrations.map((integration) =>
    toIntegrationSummary(catalog, integration)
  );
});

export const getIntegration = Effect.fn("getIntegration")(function* (
  integrationId: string
) {
  const repo = yield* IntegrationRepo;
  const { catalog } = yield* Extensions;
  const logger = (yield* AppLogger).get("integrations").with({ integrationId });

  const integration = yield* repo
    .findById(integrationId)
    .pipe(Effect.catchTags(onReadFailure(logger, "Failed to get integration")));

  if (!integration) {
    yield* logger.warn("Integration not found");
    return yield* new NotFound({ error: "Integration not found" });
  }

  return toIntegrationWithConfig(catalog, integration);
});

export const putIntegration = Effect.fn("putIntegration")(function* (
  integrationId: string,
  body: {
    name?: string | undefined;
    config?: IntegrationConfig | undefined;
  }
) {
  if (hasReservedOAuthGrant(body.config)) {
    return yield* new InvalidInput({
      error: "The OAuth grant config key is reserved.",
    });
  }
  const repo = yield* IntegrationRepo;
  const { catalog } = yield* Extensions;
  const logger = (yield* AppLogger).get("integrations").with({ integrationId });
  const onRepoFailure = onReadFailure(logger, "Failed to update integration");

  const existingIntegration = yield* repo
    .findById(integrationId)
    .pipe(Effect.catchTags(onRepoFailure));

  if (!existingIntegration) {
    yield* logger.warn("Integration not found for update");
    return yield* new NotFound({ error: "Integration not found" });
  }

  const managedCredentialKeys = oauthCredentialKeys(existingIntegration.config);
  if (rejectsOAuthCredentialOverride(body.config, managedCredentialKeys)) {
    return yield* oauthCredentialOverrideFailure();
  }

  // A config the browser sent back still carries the mask over each secret, so
  // the stored value has to be merged back in before anything is written.
  const mergedConfig = body.config
    ? mergeIntegrationConfig(
        catalog,
        existingIntegration.type,
        existingIntegration.config,
        body.config
      )
    : undefined;

  const updatePayload =
    mergedConfig === undefined
      ? omitBy({ name: body.name }, isNil)
      : omitUndefined({
          name: body.name,
          config: mergedConfig,
          expectedRevision: existingIntegration.configRevision,
        });

  const outcome = yield* repo
    .update(integrationId, updatePayload)
    .pipe(Effect.catchTags(onRepoFailure));

  if (outcome.status === "not_found") {
    yield* logger.warn("Integration not found for update");
    return yield* new NotFound({ error: "Integration not found" });
  }
  if (outcome.status === "conflict") {
    yield* logger.warn("Integration config changed during update");
    return yield* new Conflict({
      error: "Integration configuration changed. Reload and try again.",
    });
  }

  return toIntegrationWithConfig(catalog, outcome.integration);
});

export const deleteIntegration = Effect.fn("deleteIntegration")(function* (
  integrationId: string
) {
  const repo = yield* IntegrationRepo;
  const logger = (yield* AppLogger).get("integrations").with({ integrationId });

  let integration = yield* repo
    .findById(integrationId)
    .pipe(
      Effect.catchTags(onReadFailure(logger, "Failed to delete integration"))
    );

  if (!integration) {
    yield* logger.warn("Integration not found for delete");
    return yield* new NotFound({ error: "Integration not found" });
  }

  const storedGrant = readStoredOAuthGrant(integration.config);
  if (hasReservedOAuthGrant(integration.config) && !storedGrant) {
    return yield* new InternalFailure({
      error:
        "The stored OAuth grant is invalid. Reconnect the integration before deleting it.",
    });
  }

  if (storedGrant) {
    const disconnect = yield* deleteIntegrationOAuth(integrationId);
    // Disconnecting a connection the grant wholly supplied removes the row, so
    // there is nothing left to delete and this call is already done.
    if (disconnect.removed) {
      const removed: IntegrationDeleted = { success: true };
      return removed;
    }
    integration = yield* repo
      .findById(integrationId)
      .pipe(
        Effect.catchTags(onReadFailure(logger, "Failed to delete integration"))
      );
    if (!integration) {
      return yield* new NotFound({ error: "Integration not found" });
    }
  }

  const claimInput = {
    integrationId,
    claimId: globalThis.crypto.randomUUID(),
    expectedRevision: integration.configRevision,
  };
  const claim = yield* repo
    .claimRefresh(claimInput)
    .pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailure(logger, "Failed to delete integration")
      )
    );

  if (claim.status === "not_found") {
    return yield* new NotFound({ error: "Integration not found" });
  }
  if (claim.status === "lost") {
    return yield* new Conflict({
      error: "Integration configuration changed during delete.",
    });
  }

  const deletion = yield* Effect.result(
    repo.deleteOwnedRefreshClaim(claimInput)
  );
  if (Result.isFailure(deletion)) {
    yield* Effect.result(repo.releaseRefreshClaim(claimInput));
    return yield* internalFailure(
      logger,
      "Failed to delete integration"
    )(deletion.failure);
  }

  if (deletion.success.status === "not_found") {
    return yield* new NotFound({ error: "Integration not found" });
  }
  if (deletion.success.status === "no_longer_owned") {
    return yield* new Conflict({
      error: "Integration configuration changed during delete.",
    });
  }

  const result: IntegrationDeleted = { success: true };
  return result;
});

export const postIntegrationsTest = Effect.fn("postIntegrationsTest")(
  function* (body: { type: string; config: IntegrationConfig }) {
    const logger = (yield* AppLogger).get("integrations").with({
      configKeys: Object.keys(body.config),
    });

    return yield* runConnectionTest(
      logger,
      describeTestFailure,
      body.type,
      credentialsFromConfig(
        findIntegration((yield* Extensions).catalog, body.type),
        body.config
      ),
      []
    );
  }
);

export const postIntegrationTest = Effect.fn("postIntegrationTest")(function* (
  integrationId: string,
  config?: IntegrationConfig
) {
  const logger = (yield* AppLogger).get("integrations").with({ integrationId });
  const resolved = yield* resolveIntegrationCredentials(integrationId);
  const extensions = yield* Extensions;
  const integration = findIntegration(
    extensions.catalog,
    resolved.integrationType
  );
  const managedCredentialKeys = resolved.oauthCredentialKeys;
  if (rejectsOAuthCredentialOverride(config, managedCredentialKeys)) {
    return yield* oauthCredentialOverrideFailure();
  }
  const credentials = config
    ? credentialsFromConfig(
        integration,
        mergeIntegrationConfig(
          extensions.catalog,
          resolved.integrationType,
          resolved.credentials,
          config
        )
      )
    : resolved.credentials;

  return yield* runConnectionTest(
    logger,
    describeSavedTestFailure,
    resolved.integrationType,
    credentials,
    // An override naming one of these was already refused above, so every key
    // here still carries the value the grant issued.
    managedCredentialKeys
  );
});

export const postIntegrations = Effect.fn("postIntegrations")(function* (body: {
  name?: string | undefined;
  type: string;
  config: IntegrationConfig;
}) {
  if (hasReservedOAuthGrant(body.config)) {
    return yield* new InvalidInput({
      error: "The OAuth grant config key is reserved.",
    });
  }
  const repo = yield* IntegrationRepo;
  const logger = (yield* AppLogger)
    .get("integrations")
    .with({ type: body.type });

  // Refusing here is what keeps a build gap from turning into credentials stored
  // for an integration this process cannot run, which would then be neither
  // testable nor maskable.
  const { catalog } = yield* Extensions;
  if (!findIntegration(catalog, body.type)) {
    return yield* new InvalidInput({
      error: describeUnavailableIntegration(catalog, body.type),
    });
  }

  const integration = yield* repo
    .insert({
      name: body.name || "",
      type: body.type,
      config: body.config,
    })
    .pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailure(logger, "Failed to create integration")
      )
    );

  return toIntegrationSummary(catalog, integration);
});
