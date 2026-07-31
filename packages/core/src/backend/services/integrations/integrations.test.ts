// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { makeExtensionsLayer } from "#src/backend/lib/effect/extensions";
import {
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
  getIntegration,
  postIntegrations,
  postIntegrationsTest,
  postIntegrationTest,
  putIntegration,
} from "#src/backend/services/integrations/integrations";
import type { IntegrationMetadata } from "@rova/shared/extensions/catalog";
import type { IntegrationConfig } from "@rova/shared/types/integration";

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
  credentialFields: [
    {
      label: "API Key",
      type: "password",
      configKey: "apiKey",
      envVar: "SLACK_API_KEY",
    },
    {
      label: "Team ID",
      type: "text",
      configKey: "teamId",
      envVar: "SLACK_TEAM_ID",
    },
  ],
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
  isManaged: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const storedSlackIntegration: StoredIntegration = {
  id: "int_1",
  name: "Slack Prod",
  type: "slack",
  config: {
    apiKey: "stored-secret",
    teamId: "team-old",
  },
  isManaged: false,
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
      updates: { name?: string; config?: IntegrationConfig };
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
          ...stored,
          id: integrationId,
          name: updates.name ?? stored.name,
          config: updates.config ?? stored.config,
          updatedAt: new Date("2026-01-03T00:00:00.000Z"),
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

describe("integration service secret handling", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("masks secret fields in the integration it returns", () =>
      Effect.gen(function* () {
        const repo = makeIntegrationRepo(storedSlackIntegration);

        const integration = yield* getIntegration("int_1").pipe(
          Effect.provide(Layer.mergeAll(repo.layer, slackCatalog))
        );

        assert.strictEqual(integration.config.apiKey, "********");
        assert.strictEqual(integration.config.teamId, "team-old");
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
              apiKey: "********",
              teamId: "team-new",
            },
          }).pipe(Effect.provide(Layer.mergeAll(repo.layer, slackCatalog)));

          assert.deepStrictEqual(repo.calls.updates, [
            {
              integrationId: "int_1",
              updates: {
                name: "Slack Updated",
                config: {
                  apiKey: "stored-secret",
                  teamId: "team-new",
                },
              },
            },
          ]);

          assert.strictEqual(integration.config.apiKey, "********");
          assert.strictEqual(integration.config.teamId, "team-new");
        })
    );

    it.effect("replaces the secret when a new value is provided", () =>
      Effect.gen(function* () {
        const repo = makeIntegrationRepo(storedSlackIntegration);

        yield* putIntegration("int_1", {
          config: {
            apiKey: "new-secret",
          },
        }).pipe(Effect.provide(Layer.mergeAll(repo.layer, slackCatalog)));

        assert.deepStrictEqual(repo.calls.updates, [
          {
            integrationId: "int_1",
            updates: {
              config: {
                apiKey: "new-secret",
                teamId: "team-old",
              },
            },
          },
        ]);
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
 * Both tests below pin the same decision: a connection test answers with the
 * message from underneath rather than the fixed sentence the other services
 * give, because the person reading it is the one who filled in the credentials
 * and only that message tells them what to change.
 */
describe("integration connection test failures", () => {
  layer(SilentAppLoggerLayer)((it) => {
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

/**
 * What the surface answers for a type it does not hold.
 *
 * Both refusals guard the same gap: an editor served by a different build than
 * this process lists integrations this one may not have, and a request naming one
 * arrives with credentials attached. Storing them would leave a connection this
 * process can neither test nor mask.
 */
describe("an integration this server does not hold", () => {
  layer(SilentAppLoggerLayer)((it) => {
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
