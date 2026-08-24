// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { makeExtensionsLayer } from "#src/backend/lib/effect/extensions";
import {
  Conflict,
  InternalFailure,
  InvalidInput,
} from "#src/backend/lib/effect/failures";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import type { IntegrationTestLoader } from "#src/backend/extensions/integration-test";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import {
  SilentAppLoggerLayer,
  stubExtensionCatalog,
  stubIntegrationRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  ENCRYPTION_KEY_MISMATCH_MESSAGE,
  EncryptionKeyMismatch,
} from "#src/backend/services/integrations/cipher";
import {
  OAUTH_GRANT_CONFIG_KEY,
  serializeStoredOAuthGrant,
} from "#src/backend/services/integrations/oauth-grant";
import {
  getIntegration,
  getIntegrations,
  postIntegrations,
  postIntegrationsTest,
  postIntegrationTest,
  putIntegration,
} from "#src/backend/services/integrations/integrations";
import type { IntegrationMetadata } from "@wfgraph/shared/extensions/catalog";
import type { IntegrationConfig } from "@wfgraph/shared/types/integration";
import { makeAppContextLayer } from "#src/backend/lib/effect/app-context";
import type { DecryptedIntegration } from "#src/backend/services/integrations/repo";

/**
 * Which config keys count as secrets is read from the assembled catalog, so these
 * tests assemble one holding a real integration rather than stubbing the module
 * that answers for it, and provide it as the Layer the service reads it through.
 */
const slackLike: IntegrationMetadata = {
  type: "slack",
  label: "Slack",
  description: "test double",
  hasTest: false,
  credentialFields: {
    SLACK_API_KEY: { label: "API Key", type: "password" },
    SLACK_TEAM_ID: { label: "Team ID", type: "text" },
  },
};

/**
 * The same integration as a definition, which is what carries a connection test.
 * `slackLike` above is the metadata half, for the cases that only mask a config.
 */
function slackDefinition(test?: IntegrationTestLoader) {
  return defineIntegration({
    type: "slack",
    label: "Slack",
    description: "test double",
    credentials: slackLike.credentialFields,
    ...(test ? { test } : {}),
    actions: {},
  });
}

type StoredIntegration = {
  id: string;
  name: string;
  type: "slack";
  config: IntegrationConfig;
  configRevision: number;
  isManaged: boolean;
  refreshState: "idle" | "refreshing" | "reauthorization_required";
  refreshClaimId: null;
  refreshClaimedAt: null;
  createdAt: Date;
  updatedAt: Date;
};

const storedSlackIntegration: StoredIntegration = {
  id: "int_1",
  name: "Slack Prod",
  type: "slack",
  config: {
    SLACK_API_KEY: "stored-secret",
    SLACK_TEAM_ID: "team-old",
  },
  configRevision: 0,
  isManaged: false,
  refreshState: "idle",
  refreshClaimId: null,
  refreshClaimedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

/**
 * A fake repository holding one integration, and a record of the updates it was
 * asked to write.
 *
 * Secret handling is what these tests are about, so the database is replaced at
 * the repository boundary: the service asks `IntegrationRepo` for the stored
 * row and this answers with a decrypted one, exactly as the live repository
 * would. Built per test rather than reset between them, so no test can see what
 * another one wrote.
 */
function makeIntegrationRepo(stored: StoredIntegration) {
  const calls = {
    updates: [] as Array<{
      integrationId: string;
      updates: {
        name?: string;
        config?: IntegrationConfig;
        expectedRevision?: number;
      };
    }>,
  };

  // Secret handling never reaches the rest of the table, so every other method
  // refuses.
  const repoLayer = stubIntegrationRepo({
    insert: (row) =>
      Effect.sync(() => ({
        ...stored,
        id: "int_new",
        name: row.name,
        config: row.config,
      })),
    findById: (integrationId) =>
      Effect.succeed(integrationId === stored.id ? stored : null),
    update: (integrationId, updates) =>
      Effect.sync(() => {
        calls.updates.push({ integrationId, updates });
        return {
          status: "updated" as const,
          integration: {
            ...stored,
            id: integrationId,
            name: updates.name ?? stored.name,
            config: updates.config ?? stored.config,
            configRevision:
              updates.config === undefined
                ? stored.configRevision
                : stored.configRevision + 1,
            updatedAt: new Date("2026-01-03T00:00:00.000Z"),
          },
        };
      }),
  });

  return { layer: repoLayer, calls };
}

/** The surface a masking case reads its secret-key declarations from. */
const slackCatalog = stubExtensionCatalog({ integrations: [slackLike] });

/** The same integration as a full assembly, which carries its connection test. */
const assembledSlack = makeExtensionsLayer(
  assembleExtensions({ integrations: [slackDefinition()] })
);

const integrationServiceTestLayer = Layer.mergeAll(
  SilentAppLoggerLayer,
  makeAppContextLayer({ apiBasePath: "/api" })
);

describe("integration service secret handling", () => {
  layer(integrationServiceTestLayer)((it) => {
    it.effect("masks secret fields in the integration it returns", () =>
      Effect.gen(function* () {
        const repo = makeIntegrationRepo(storedSlackIntegration);

        const integration = yield* getIntegration("int_1").pipe(
          Effect.provide(Layer.mergeAll(repo.layer, slackCatalog))
        );

        assert.strictEqual(integration.config.SLACK_API_KEY, "********");
        assert.strictEqual(integration.config.SLACK_TEAM_ID, "team-old");
        assert.notProperty(integration, "configRevision");
      })
    );

    it.effect(
      "preserves masked secrets and merges partial config updates",
      () =>
        Effect.gen(function* () {
          const repo = makeIntegrationRepo(storedSlackIntegration);

          const integration = yield* putIntegration("int_1", {
            name: "Slack Updated",
            config: {
              SLACK_API_KEY: "********",
              SLACK_TEAM_ID: "team-new",
            },
          }).pipe(Effect.provide(Layer.mergeAll(repo.layer, slackCatalog)));

          assert.deepStrictEqual(repo.calls.updates, [
            {
              integrationId: "int_1",
              updates: {
                name: "Slack Updated",
                config: {
                  SLACK_API_KEY: "stored-secret",
                  SLACK_TEAM_ID: "team-new",
                },
                expectedRevision: 0,
              },
            },
          ]);

          assert.strictEqual(integration.config.SLACK_API_KEY, "********");
          assert.strictEqual(integration.config.SLACK_TEAM_ID, "team-new");
        })
    );

    it.effect("replaces the secret when a new value is provided", () =>
      Effect.gen(function* () {
        const repo = makeIntegrationRepo(storedSlackIntegration);

        yield* putIntegration("int_1", {
          config: {
            SLACK_API_KEY: "new-secret",
          },
        }).pipe(Effect.provide(Layer.mergeAll(repo.layer, slackCatalog)));

        assert.deepStrictEqual(repo.calls.updates, [
          {
            integrationId: "int_1",
            updates: {
              config: {
                SLACK_API_KEY: "new-secret",
                SLACK_TEAM_ID: "team-old",
              },
              expectedRevision: 0,
            },
          },
        ]);
      })
    );

    it.effect(
      "returns Conflict when an owned refresh wins a manual config race",
      () =>
        Effect.gen(function* () {
          let current: DecryptedIntegration = {
            ...storedSlackIntegration,
            config: { SLACK_API_KEY: "old-secret" },
          };
          const repo = stubIntegrationRepo({
            findById: () => Effect.succeed(current),
            update: (_integrationId, updates) =>
              Effect.sync(() => {
                assert.ok("expectedRevision" in updates);
                assert.strictEqual(updates.expectedRevision, 0);
                current = {
                  ...current,
                  config: { SLACK_API_KEY: "refreshed-secret" },
                  configRevision: 1,
                };
                return { status: "conflict" as const };
              }),
          });

          const failure = yield* putIntegration("int_1", {
            config: { SLACK_API_KEY: "manual-secret" },
          }).pipe(
            Effect.provide(Layer.mergeAll(repo, slackCatalog)),
            Effect.flip
          );

          assert.instanceOf(failure, Conflict);
          assert.deepStrictEqual(current.config, {
            SLACK_API_KEY: "refreshed-secret",
          });
          assert.strictEqual(current.configRevision, 1);
        })
    );
  });
});

describe("integration OAuth grant visibility", () => {
  layer(integrationServiceTestLayer)((it) => {
    it.effect(
      "omits the private grant and returns its sanitized connection status",
      () =>
        Effect.gen(function* () {
          const stored = {
            ...storedSlackIntegration,
            config: {
              ...storedSlackIntegration.config,
              [OAUTH_GRANT_CONFIG_KEY]: serializeStoredOAuthGrant({
                credentials: { SLACK_API_KEY: "oauth-secret" },
                tokens: { accessToken: "oauth-secret" },
                connectedAt: "2026-08-24T00:00:00.000Z",
                accountLabel: "Production workspace",
              }),
            },
            refreshState: "reauthorization_required" as const,
          };
          const repo = makeIntegrationRepo(stored);

          const response = yield* getIntegration("int_1").pipe(
            Effect.provide(Layer.mergeAll(repo.layer, slackCatalog))
          );

          assert.notProperty(response.config, OAUTH_GRANT_CONFIG_KEY);
          assert.deepStrictEqual(response.oauth, {
            status: "reauthorization_required",
            connectedAt: "2026-08-24T00:00:00.000Z",
            accountLabel: "Production workspace",
          });
        })
    );

    it.effect(
      "refuses a manual update carrying OAuth's reserved config key",
      () =>
        Effect.gen(function* () {
          const repo = makeIntegrationRepo(storedSlackIntegration);

          const failure = yield* putIntegration("int_1", {
            config: { [OAUTH_GRANT_CONFIG_KEY]: "forged" },
          }).pipe(
            Effect.provide(Layer.mergeAll(repo.layer, slackCatalog)),
            Effect.flip
          );

          assert.instanceOf(failure, InvalidInput);
          assert.strictEqual(repo.calls.updates.length, 0);
        })
    );
  });
});

/**
 * A repository whose read fails the way a database that has gone away does.
 */
const unreadableIntegrationRepo = stubIntegrationRepo({
  findById: () =>
    Effect.fail(
      new DatabaseError({
        cause: new Error("terminating connection due to administrator command"),
      })
    ),
});

/**
 * A repository whose rows were sealed under a key this process is not running
 * with, which is what a rotated `encryption.key` looks like from above.
 */
const keyMismatch = Effect.fail(
  new EncryptionKeyMismatch({ cause: new Error("bad auth tag") })
);

const keyMismatchRepo = stubIntegrationRepo({
  listByType: () => keyMismatch,
  findById: () => keyMismatch,
  update: () => keyMismatch,
});

/** Every read path answers the one sentence a person can act on. */
describe("a rotated encryption key", () => {
  layer(integrationServiceTestLayer)((it) => {
    // This case spells the words out, where the three below compare against the
    // exported constant. Asserting only the constant would let it agree with
    // itself whatever it said, so one case has to hold the wording.
    it.effect("names the key and both ways out of it, when listing", () =>
      Effect.gen(function* () {
        const failure = yield* getIntegrations().pipe(
          Effect.provide(keyMismatchRepo),
          Effect.flip
        );

        assert.instanceOf(failure, InternalFailure);
        assert.include(failure.error, "encryption.key");
        assert.include(failure.error, "start the app with that key");
        assert.include(failure.error, "delete the connections");
      })
    );

    it.effect("says so when one integration is read", () =>
      Effect.gen(function* () {
        const failure = yield* getIntegration("int_1").pipe(
          Effect.provide(Layer.mergeAll(keyMismatchRepo, slackCatalog)),
          Effect.flip
        );

        assert.instanceOf(failure, InternalFailure);
        assert.strictEqual(failure.error, ENCRYPTION_KEY_MISMATCH_MESSAGE);
      })
    );

    // An update reads the stored row first, to merge the masked secrets back in,
    // so it hits the same wall before it writes anything.
    it.effect("says so when an update reads the row it would merge into", () =>
      Effect.gen(function* () {
        const failure = yield* putIntegration("int_1", {
          name: "Slack Updated",
        }).pipe(
          Effect.provide(Layer.mergeAll(keyMismatchRepo, slackCatalog)),
          Effect.flip
        );

        assert.instanceOf(failure, InternalFailure);
        assert.strictEqual(failure.error, ENCRYPTION_KEY_MISMATCH_MESSAGE);
      })
    );

    // A connection test relays what the row's read said, and this is the one
    // thing it can say that a fixed sentence would have hidden.
    it.effect("says so when a saved connection is tested", () =>
      Effect.gen(function* () {
        const failure = yield* postIntegrationTest("int_1").pipe(
          Effect.provide(Layer.mergeAll(keyMismatchRepo, assembledSlack)),
          Effect.flip
        );

        assert.instanceOf(failure, InternalFailure);
        assert.strictEqual(failure.error, ENCRYPTION_KEY_MISMATCH_MESSAGE);
      })
    );
  });
});

/**
 * Both tests below pin the same decision: a connection test answers with the
 * message from underneath rather than the fixed sentence the other services
 * give, because the person reading it is the one who filled in the credentials
 * and only that message tells them what to change.
 */
describe("integration connection test failures", () => {
  layer(integrationServiceTestLayer)((it) => {
    it.effect("answers with what the vendor's test function threw", () =>
      Effect.gen(function* () {
        // A vendor SDK that throws instead of answering, which is the case the
        // loader and the vendor call are both wrapped for.
        const throwingSlack = makeExtensionsLayer(
          assembleExtensions({
            integrations: [
              slackDefinition(() =>
                Promise.resolve(() => {
                  throw new Error("vendor said no");
                })
              ),
            ],
          })
        );
        const repo = makeIntegrationRepo(storedSlackIntegration);

        const failure = yield* postIntegrationTest("int_1").pipe(
          Effect.provide(Layer.mergeAll(repo.layer, throwingSlack)),
          Effect.flip
        );

        assert.instanceOf(failure, InternalFailure);
        assert.strictEqual(failure.error, "vendor said no");
      })
    );

    // The credentials dialog draws the button off `hasTest`, so a request for a
    // test an integration does not declare arrives only when the two disagree.
    it.effect("refuses a test an integration does not declare", () =>
      Effect.gen(function* () {
        const repo = makeIntegrationRepo(storedSlackIntegration);

        const failure = yield* postIntegrationTest("int_1").pipe(
          Effect.provide(Layer.mergeAll(repo.layer, assembledSlack)),
          Effect.flip
        );

        assert.instanceOf(failure, InvalidInput);
        assert.include(failure.error, "declares no test");
      })
    );

    it.effect(
      "answers with the database message when the row cannot be read",
      () =>
        Effect.gen(function* () {
          const failure = yield* postIntegrationTest("int_1").pipe(
            Effect.provide(
              Layer.mergeAll(unreadableIntegrationRepo, assembledSlack)
            ),
            Effect.flip
          );

          assert.instanceOf(failure, InternalFailure);
          assert.strictEqual(
            failure.error,
            "terminating connection due to administrator command"
          );
        })
    );
  });
});

describe("saved OAuth connection tests", () => {
  layer(integrationServiceTestLayer)((it) => {
    it.effect(
      "tests the replacement credentials after refreshing an expired grant",
      () =>
        Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          let current: DecryptedIntegration = {
            ...storedSlackIntegration,
            config: {
              SLACK_TEAM_ID: "team-old",
              [OAUTH_GRANT_CONFIG_KEY]: serializeStoredOAuthGrant({
                credentials: { SLACK_API_KEY: "old-access" },
                tokens: {
                  accessToken: "old-access",
                  refreshToken: "old-refresh",
                  expiresAt: new Date(now - 1_000).toISOString(),
                },
                connectedAt: "2026-08-01T00:00:00.000Z",
              }),
            },
          };
          let testedCredentials: Record<string, string | undefined> | undefined;
          const definition = defineIntegration({
            type: "slack",
            label: "Slack",
            description: "test double",
            credentials: slackLike.credentialFields,
            test: async () => (credentials) => {
              testedCredentials = credentials;
              return Promise.resolve({ success: true as const });
            },
            oauth: {
              label: "Slack OAuth",
              registerClient: () => ({ clientId: "slack-client" }),
              authorize: () => new URL("https://provider.example/authorize"),
              exchange: async () => ({
                credentials: { SLACK_API_KEY: "exchange-access" },
                tokens: { accessToken: "exchange-access" },
              }),
              refresh: async () => ({
                credentials: { SLACK_API_KEY: "replacement-access" },
                tokens: {
                  accessToken: "replacement-access",
                  refreshToken: "replacement-refresh",
                  expiresAt: new Date(now + 3_600_000).toISOString(),
                },
              }),
              revoke: async () => undefined,
            },
            actions: {},
          });
          const repo = stubIntegrationRepo({
            findById: () => Effect.succeed(current),
            claimRefresh: ({ claimId }) =>
              Effect.sync(() => {
                current = {
                  ...current,
                  refreshState: "refreshing" as const,
                  refreshClaimId: claimId,
                  refreshClaimedAt: new Date(),
                };
                return { status: "acquired" as const };
              }),
            completeRefresh: ({ claimId, config }) =>
              Effect.sync(() => {
                if (current.refreshClaimId !== claimId) return false;
                current = {
                  ...current,
                  config,
                  refreshState: "idle",
                  refreshClaimId: null,
                  refreshClaimedAt: null,
                };
                return true;
              }),
          });

          const result = yield* postIntegrationTest("int_1").pipe(
            Effect.provide(
              Layer.mergeAll(
                repo,
                makeExtensionsLayer(
                  assembleExtensions({ integrations: [definition] })
                ),
                makeAppContextLayer({
                  publicUrl: "https://workflows.example.com",
                  apiBasePath: "/api",
                })
              )
            )
          );

          assert.deepStrictEqual(result, {
            status: "success",
            message: "Connection successful",
          });
          assert.deepStrictEqual(testedCredentials, {
            SLACK_API_KEY: "replacement-access",
            SLACK_TEAM_ID: "team-old",
          });
        })
    );
  });
});

/**
 * What the surface answers for a type it does not hold.
 *
 * Both refusals guard the same gap: an editor served by a different build than
 * this process lists integrations this one may not have, and a request naming one
 * arrives with credentials attached. Storing them would leave a connection this
 * process can neither test nor mask.
 */
describe("an integration this server does not hold", () => {
  layer(integrationServiceTestLayer)((it) => {
    it.effect("refuses to test it", () =>
      Effect.gen(function* () {
        const failure = yield* postIntegrationsTest({
          type: "notion",
          config: { apiKey: "secret" },
        }).pipe(Effect.provide(assembledSlack), Effect.flip);

        assert.instanceOf(failure, InvalidInput);
        assert.include(failure.error, "extensions.integrations");
        // The list is what shows the cause: this build and the editor's disagree.
        assert.include(failure.error, "This server holds: slack.");
      })
    );

    it.effect("refuses to store credentials for it, naming the option", () =>
      Effect.gen(function* () {
        const repo = makeIntegrationRepo(storedSlackIntegration);

        const failure = yield* postIntegrations({
          name: "Notion",
          type: "notion",
          config: { apiKey: "secret" },
        }).pipe(
          Effect.provide(Layer.mergeAll(repo.layer, assembledSlack)),
          Effect.flip
        );

        assert.instanceOf(failure, InvalidInput);
        assert.include(failure.error, "extensions.integrations");
      })
    );

    // An empty assembly is the default a host gets by passing no integrations at
    // all, so the sentence has to read as a sentence rather than trail off after
    // "This server holds:" with nothing listed.
    it.effect(
      "says it holds none, rather than trailing off, on an empty assembly",
      () =>
        Effect.gen(function* () {
          const failure = yield* postIntegrationsTest({
            type: "notion",
            config: { apiKey: "secret" },
          }).pipe(
            Effect.provide(makeExtensionsLayer(assembleExtensions({}))),
            Effect.flip
          );

          assert.instanceOf(failure, InvalidInput);
          assert.include(
            failure.error,
            "This server holds no integration at all."
          );
        })
    );
  });
});
