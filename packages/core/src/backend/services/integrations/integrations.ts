import { Effect } from "effect";
import { mapValues, omitBy } from "es-toolkit/object";
import { isNil } from "es-toolkit/predicate";
import postgres, { type Sql } from "postgres";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
import { internalFailure } from "#src/backend/lib/effect/database";
import {
  InternalFailure,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import {
  getCredentialMapping,
  getIntegrationTypes,
  getIntegration as getPluginFromRegistry,
} from "@rova/shared/plugins/registry";
import type {
  IntegrationConfig,
  IntegrationType,
} from "@rova/shared/types/integration";
import { getErrorMessage } from "@rova/shared/utils";
import {
  createSecretConfigKeyTest,
  maskIntegrationConfig,
  SECRET_MASK,
} from "./integration-config-masking";
import { getIntegrationTestFunction } from "./integration-test-loaders";
import { IntegrationRepo } from "./repo";

type IntegrationSummary = {
  id: string;
  name: string;
  type: IntegrationType;
  isManaged?: boolean;
  createdAt: string;
  updatedAt: string;
};

type IntegrationWithConfig = IntegrationSummary & {
  config: IntegrationConfig;
};

type IntegrationTestResult = {
  status: "success" | "error";
  message: string;
};

/** The contract answers a delete with this and nothing else. */
type IntegrationDeleted = { success: true };

// Reaching here means the integration's metadata is registered but its
// connection test is not, which is what importing "@rova/plugins" without
// "@rova/plugins/server" leaves behind. Naming the missing import beats telling
// someone their integration does not support a test it does support.
const MISSING_TEST_MESSAGE =
  'Connection testing is unavailable for this integration. A host that imports "@rova/plugins" also has to import "@rova/plugins/server", which registers the connection tests.';

const createDatabaseConnection = (url: string): Sql =>
  postgres(url, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
  });

function mergeIntegrationConfig(
  type: IntegrationType,
  currentConfig: IntegrationConfig,
  updates?: IntegrationConfig
): IntegrationConfig {
  if (!updates) {
    return currentConfig;
  }

  const isSecretKey = createSecretConfigKeyTest(type);
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
  type: IntegrationType;
  isManaged?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}): IntegrationSummary {
  return {
    id: input.id,
    name: input.name,
    type: input.type,
    isManaged: input.isManaged ?? false,
    createdAt: input.createdAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
  };
}

function toIntegrationWithConfig(input: {
  id: string;
  name: string;
  type: IntegrationType;
  config: IntegrationConfig;
  isManaged?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}): IntegrationWithConfig {
  return {
    ...toIntegrationSummary(input),
    config: maskIntegrationConfig(input.type, input.config),
  };
}

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

/**
 * How a connection test reports something that threw.
 *
 * The other services answer with a fixed sentence and put the underlying message
 * in the log, which is what `internalFailure` does. A connection test is the one
 * place where the underlying message is the answer: "password authentication
 * failed" is what the person filling in the credentials form needs to read, so
 * it is what reaches them.
 *
 * Used directly only where a `DatabaseError` has to be reported this way;
 * everything a test actually runs goes through `attemptTestStep`.
 */
const testFailure =
  (logger: EffectLogger, describe: DescribeTestFailure) =>
  (cause: unknown): Effect.Effect<never, InternalFailure> =>
    Effect.gen(function* () {
      yield* logger.error(describe(cause), { error: cause });
      return yield* Effect.fail(
        new InternalFailure({
          error:
            cause instanceof Error
              ? cause.message
              : "Failed to test connection",
          cause,
        })
      );
    });

/**
 * Run one step of a connection test, reporting a throw the way `testFailure`
 * does.
 *
 * The plugin registry, the test loader's dynamic import, and the vendor call
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
      catch: (cause) => cause,
    }).pipe(Effect.catch(testFailure(logger, describe)));

/**
 * Does this (type, config) pair connect?
 *
 * Both endpoints ask exactly that; `postIntegrationTest` reads the pair out of a
 * stored row first and `postIntegrationsTest` is handed one that was typed into
 * the credentials form. Everything after the read is the same work, so it lives
 * here once: the database branch, the plugin lookup, the test lookup, the
 * credential mapping, and the answer the UI shows.
 */
const runConnectionTest = Effect.fn("runConnectionTest")(function* (
  callerLogger: EffectLogger,
  describe: DescribeTestFailure,
  type: IntegrationType,
  config: IntegrationConfig
) {
  const logger = callerLogger.with({ type });
  const attempt = attemptTestStep(logger, describe);

  if (type === "database") {
    return yield* attempt(() => testDatabaseConnection(config.url));
  }

  // The plugin registry is module-level state that stage 6 of ADR-0002 owns,
  // so it stays a plain function call rather than becoming a service here.
  const plugin = getPluginFromRegistry(type);

  if (!plugin) {
    yield* logger.warn("Invalid integration type for test", {
      availableTypes: getIntegrationTypes(),
    });
    return yield* Effect.fail(
      new InvalidInput({ error: "Invalid integration type" })
    );
  }

  const testFn = yield* attempt(() => getIntegrationTestFunction(type));
  if (!testFn) {
    yield* logger.warn(MISSING_TEST_MESSAGE);
    return yield* Effect.fail(
      new InvalidInput({ error: MISSING_TEST_MESSAGE })
    );
  }

  const credentials = yield* attempt(() =>
    getCredentialMapping(plugin, config)
  );
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

  const answer: IntegrationTestResult = {
    status: testResult.success ? "success" : "error",
    message: testResult.success
      ? "Connection successful"
      : testResult.error || "Connection failed",
  };
  return answer;
});

export const getIntegrations = Effect.fn("getIntegrations")(function* (
  type?: IntegrationType
) {
  const repo = yield* IntegrationRepo;
  const logger = (yield* AppLogger)
    .get("integrations")
    .with({ type: type ?? null });

  const integrations = yield* repo
    .listByType(type)
    .pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailure(logger, "Failed to get integrations")
      )
    );

  return integrations.map(toIntegrationSummary);
});

export const getIntegration = Effect.fn("getIntegration")(function* (
  integrationId: string
) {
  const repo = yield* IntegrationRepo;
  const logger = (yield* AppLogger).get("integrations").with({ integrationId });

  const integration = yield* repo
    .findById(integrationId)
    .pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailure(logger, "Failed to get integration")
      )
    );

  if (!integration) {
    yield* logger.warn("Integration not found");
    return yield* Effect.fail(new NotFound({ error: "Integration not found" }));
  }

  return toIntegrationWithConfig(integration);
});

export const putIntegration = Effect.fn("putIntegration")(function* (
  integrationId: string,
  body: {
    name?: string;
    config?: IntegrationConfig;
  }
) {
  const repo = yield* IntegrationRepo;
  const logger = (yield* AppLogger).get("integrations").with({ integrationId });
  const onDatabaseError = internalFailure(
    logger,
    "Failed to update integration"
  );

  const existingIntegration = yield* repo
    .findById(integrationId)
    .pipe(Effect.catchTag("DatabaseError", onDatabaseError));

  if (!existingIntegration) {
    yield* logger.warn("Integration not found for update");
    return yield* Effect.fail(new NotFound({ error: "Integration not found" }));
  }

  // A config the browser sent back still carries the mask over each secret, so
  // the stored value has to be merged back in before anything is written.
  const mergedConfig = body.config
    ? mergeIntegrationConfig(
        existingIntegration.type,
        existingIntegration.config,
        body.config
      )
    : undefined;

  const updatePayload = omitBy(
    {
      name: body.name,
      config: mergedConfig,
    },
    isNil
  );

  const integration = yield* repo
    .update(integrationId, updatePayload)
    .pipe(Effect.catchTag("DatabaseError", onDatabaseError));

  if (!integration) {
    yield* logger.warn("Integration not found for update");
    return yield* Effect.fail(new NotFound({ error: "Integration not found" }));
  }

  return toIntegrationWithConfig(integration);
});

export const deleteIntegration = Effect.fn("deleteIntegration")(function* (
  integrationId: string
) {
  const repo = yield* IntegrationRepo;
  const logger = (yield* AppLogger).get("integrations").with({ integrationId });

  const deleted = yield* repo
    .deleteById(integrationId)
    .pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailure(logger, "Failed to delete integration")
      )
    );

  if (!deleted) {
    yield* logger.warn("Integration not found for delete");
    return yield* Effect.fail(new NotFound({ error: "Integration not found" }));
  }

  const result: IntegrationDeleted = { success: true };
  return result;
});

export const postIntegrationsTest = Effect.fn("postIntegrationsTest")(
  function* (body: { type: IntegrationType; config: IntegrationConfig }) {
    const logger = (yield* AppLogger).get("integrations").with({
      configKeys: Object.keys(body.config),
    });

    return yield* runConnectionTest(
      logger,
      describeTestFailure,
      body.type,
      body.config
    );
  }
);

export const postIntegrationTest = Effect.fn("postIntegrationTest")(function* (
  integrationId: string
) {
  const repo = yield* IntegrationRepo;
  const logger = (yield* AppLogger).get("integrations").with({ integrationId });

  // A database failure here is reported the way a failing test is, so the row
  // that could not be read says why rather than answering a fixed sentence.
  const integration = yield* repo
    .findById(integrationId)
    .pipe(
      Effect.catchTag("DatabaseError", ({ cause }) =>
        testFailure(logger, describeSavedTestFailure)(cause)
      )
    );

  if (!integration) {
    yield* logger.warn("Integration not found for test");
    return yield* Effect.fail(new NotFound({ error: "Integration not found" }));
  }

  return yield* runConnectionTest(
    logger,
    describeSavedTestFailure,
    integration.type,
    integration.config
  );
});

/**
 * Probe a Postgres URL by opening a connection and closing it again.
 *
 * Still a Promise: it owns a connection it has to close on every path, which
 * `try/finally` states in one place. A failed probe is a test result rather than
 * a service failure, so nothing here reaches the error channel.
 */
async function testDatabaseConnection(
  databaseUrl?: string
): Promise<IntegrationTestResult> {
  let connection: Sql | null = null;

  try {
    if (!databaseUrl) {
      return {
        status: "error",
        message: "Connection failed",
      };
    }

    connection = createDatabaseConnection(databaseUrl);

    await connection`SELECT 1`;

    return {
      status: "success",
      message: "Connection successful",
    };
  } catch {
    return {
      status: "error",
      message: "Connection failed",
    };
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

export const postIntegrations = Effect.fn("postIntegrations")(function* (body: {
  name?: string;
  type: IntegrationType;
  config: IntegrationConfig;
}) {
  const repo = yield* IntegrationRepo;
  const logger = (yield* AppLogger)
    .get("integrations")
    .with({ type: body.type });

  // The editor bundled with @rova/core lists every built-in integration, while
  // the server only knows the ones something registered. Refusing here is what
  // keeps that gap from turning into credentials stored for an integration this
  // process cannot run, which would then be neither testable nor maskable.
  if (body.type !== "database" && !getPluginFromRegistry(body.type)) {
    return yield* Effect.fail(
      new InvalidInput({
        error: `Integration "${body.type}" is not available on this server. Import "@rova/plugins" to enable the built-in integrations.`,
      })
    );
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
