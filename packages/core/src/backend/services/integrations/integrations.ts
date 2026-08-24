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
import type { IntegrationConfig } from "@wfgraph/shared/types/integration";
import { getErrorMessage } from "@wfgraph/shared/utils";
import { ENCRYPTION_KEY_MISMATCH_MESSAGE } from "#src/backend/services/integrations/cipher";
import {
  createSecretConfigKeyTest,
  maskIntegrationConfig,
  SECRET_MASK,
} from "#src/backend/services/integrations/integration-config-masking";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import {
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
  oauth?: {
    status: "connected" | "reauthorization_required";
    connectedAt: string;
    accountLabel?: string;
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

/**
 * What an editor served by a different build than this process runs into: it lists
 * an integration this server does not hold, and a request naming one arrives with
 * credentials attached. Both refusals below say what is available rather than only
 * that the request was wrong, because the two builds disagreeing is the cause and
 * the list is what shows it.
 */
function describeUnavailableIntegration(
  catalog: ExtensionCatalog,
  type: string
): string {
  const available = catalog.integrations
    .map((integration) => integration.type)
    .toSorted();

  const holds =
    available.length > 0
      ? `This server holds: ${available.join(", ")}.`
      : "This server holds no integration at all.";

  return `Integration "${type}" is not available on this server. Pass it to createWfGraphApp under extensions.integrations, or pass builtInIntegrations() from "@wfgraph/plugins" for the built-in ones. ${holds}`;
}

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
  type: string;
  isManaged?: boolean | null;
  config: IntegrationConfig;
  refreshState: "idle" | "refreshing" | "reauthorization_required";
  createdAt: Date;
  updatedAt: Date;
}): IntegrationSummary {
  const grant = readStoredOAuthGrant(input.config);
  return {
    id: input.id,
    name: input.name,
    type: input.type,
    isManaged: input.isManaged ?? false,
    createdAt: input.createdAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
    ...(grant
      ? {
          oauth: {
            status:
              input.refreshState === "reauthorization_required"
                ? ("reauthorization_required" as const)
                : ("connected" as const),
            connectedAt: grant.connectedAt,
            ...(grant.accountLabel ? { accountLabel: grant.accountLabel } : {}),
          },
        }
      : {}),
  };
}

function toIntegrationWithConfig(
  catalog: ExtensionCatalog,
  input: {
    id: string;
    name: string;
    type: string;
    config: IntegrationConfig;
    isManaged?: boolean | null;
    refreshState: "idle" | "refreshing" | "reauthorization_required";
    createdAt: Date;
    updatedAt: Date;
  }
): IntegrationWithConfig {
  return {
    ...toIntegrationSummary(input),
    config: maskIntegrationConfig(
      catalog,
      input.type,
      Object.fromEntries(
        Object.entries(input.config).filter(
          ([key]) => key !== OAUTH_GRANT_CONFIG_KEY
        )
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
 * How a connection test words the log line for something that threw.
 *
 * The two endpoints word theirs differently, and both wordings predate the
 * migration, so the wording is passed in rather than fixed.
 */
type DescribeTestFailure = (cause: unknown) => string;

const describeTestFailure: DescribeTestFailure = (cause) =>
  `Failed to test integration connection: ${getErrorMessage(cause)}`;

const describeSavedTestFailure: DescribeTestFailure = () =>
  "Failed to test saved integration connection";

const toTestFailure = (cause: unknown): InternalFailure =>
  new InternalFailure({
    error: cause instanceof Error ? cause.message : "Failed to test connection",
    cause,
  });

/**
 * Run one step of a connection test and keep its failure in the Effect channel.
 *
 * The catalog lookup, the test loader's dynamic import, and the vendor call
 * itself all sit outside the database, and the pre-Effect code caught them in
 * the same `try` as the query. This is that `try`, one step at a time.
 */
const attemptTestStep =
  (logger: EffectLogger, describe: DescribeTestFailure) =>
  <A>(run: () => Promise<A> | A): Effect.Effect<A, InternalFailure> =>
    Effect.tryPromise({
      // The async wrapper is what makes a synchronous throw catchable: without
      // it `run()` throws before a promise exists and the throw escapes past
      // `catch` as a defect.
      try: async () => await run(),
      catch: toTestFailure,
    }).pipe(
      Effect.tapError((failure) =>
        logger.error(describe(failure.cause), { error: failure.cause })
      )
    );

/**
 * Does this integration type connect with these declared credentials?
 *
 * The saved endpoint resolves and refreshes its credential map first. The
 * unsaved endpoint maps the config that the caller supplied directly.
 */
const runConnectionTest = Effect.fn("runConnectionTest")(function* (
  callerLogger: EffectLogger,
  describe: DescribeTestFailure,
  type: string,
  credentials: Record<string, string | undefined>
) {
  const logger = callerLogger.with({ type });
  const attempt = attemptTestStep(logger, describe);

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

  const testResult = yield* attempt(() => testFn(credentials));

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

  const integrations = yield* repo
    .listByType(type)
    .pipe(
      Effect.catchTags(onReadFailure(logger, "Failed to get integrations"))
    );

  return integrations.map(toIntegrationSummary);
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
    name?: string;
    config?: IntegrationConfig;
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
      : {
          ...(body.name === undefined ? {} : { name: body.name }),
          config: mergedConfig,
          expectedRevision: existingIntegration.configRevision,
        };

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
    yield* deleteIntegrationOAuth(integrationId);
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
      )
    );
  }
);

export const postIntegrationTest = Effect.fn("postIntegrationTest")(function* (
  integrationId: string
) {
  const logger = (yield* AppLogger).get("integrations").with({ integrationId });
  const resolved = yield* resolveIntegrationCredentials(integrationId);

  return yield* runConnectionTest(
    logger,
    describeSavedTestFailure,
    resolved.integrationType,
    resolved.credentials
  );
});

export const postIntegrations = Effect.fn("postIntegrations")(function* (body: {
  name?: string;
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

  return toIntegrationSummary(integration);
});
