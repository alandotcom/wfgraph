// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { afterEach, assert, describe, layer } from "@effect/vitest";
import { Effect } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import {
  clearExtensions,
  configureExtensions,
} from "#src/backend/lib/extensions/current";
import { defineIntegration } from "#src/backend/lib/extensions/define-integration";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
import {
  configureTestExtensions,
  SilentAppLoggerLayer,
  stubIntegrationRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  registerIntegrationTest,
  unregisterIntegrationTest,
} from "#src/backend/services/integrations/integration-test-loaders";
import {
  getIntegration,
  postIntegrationTest,
  putIntegration,
} from "#src/backend/services/integrations/integrations";
import type { IntegrationMetadata } from "@rova/shared/extensions/catalog";
import type { IntegrationConfig } from "@rova/shared/types/integration";

/**
 * Which config keys count as secrets is read from the assembled catalog, so these
 * tests assemble one holding a real integration rather than stubbing the module
 * that answers for it. The surface is process-wide state that stage 7 of ADR-0002
 * owns; until then, clearing it after each test is what keeps it from leaking into
 * another file's run.
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
    },
    { label: "Team ID", type: "text", configKey: "teamId" },
  ],
};

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

describe("integration service secret handling", () => {
  afterEach(() => {
    clearExtensions();
  });

  layer(SilentAppLoggerLayer)((it) => {
    it.effect("masks secret fields in the integration it returns", () =>
      Effect.gen(function* () {
        configureTestExtensions({ integrations: [slackLike] });
        const repo = makeIntegrationRepo(storedSlackIntegration);

        const integration = yield* getIntegration("int_1").pipe(
          Effect.provide(repo.layer)
        );

        assert.strictEqual(integration.config.apiKey, "********");
        assert.strictEqual(integration.config.teamId, "team-old");
      })
    );

    it.effect(
      "preserves masked secrets and merges partial config updates",
      () =>
        Effect.gen(function* () {
          configureTestExtensions({ integrations: [slackLike] });
          const repo = makeIntegrationRepo(storedSlackIntegration);

          const integration = yield* putIntegration("int_1", {
            name: "Slack Updated",
            config: {
              apiKey: "********",
              teamId: "team-new",
            },
          }).pipe(Effect.provide(repo.layer));

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
        configureTestExtensions({ integrations: [slackLike] });
        const repo = makeIntegrationRepo(storedSlackIntegration);

        yield* putIntegration("int_1", {
          config: {
            apiKey: "new-secret",
          },
        }).pipe(Effect.provide(repo.layer));

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
  afterEach(() => {
    clearExtensions();
    unregisterIntegrationTest("slack");
  });

  layer(SilentAppLoggerLayer)((it) => {
    it.effect("answers with what the vendor's test function threw", () =>
      Effect.gen(function* () {
        configureTestExtensions({ integrations: [slackLike] });
        // A vendor SDK that throws instead of answering, which is the case the
        // registry lookup and the vendor call are wrapped for.
        registerIntegrationTest("slack", () =>
          Promise.resolve(() => {
            throw new Error("vendor said no");
          })
        );
        const repo = makeIntegrationRepo(storedSlackIntegration);

        const failure = yield* postIntegrationTest("int_1").pipe(
          Effect.provide(repo.layer),
          Effect.flip
        );

        assert.instanceOf(failure, InternalFailure);
        assert.strictEqual(failure.error, "vendor said no");
      })
    );

    // Two sources answer for a connection test while both halves of the surface
    // exist: an integration passed to `createRovaApp` carries its own, and the map
    // holds the plugins B4 has not ported. The definition's is the one that runs,
    // so a ported integration is not shadowed by a registration left behind.
    it.effect("prefers the test an assembled integration carries", () =>
      Effect.gen(function* () {
        configureExtensions(
          assembleExtensions({
            integrations: [
              defineIntegration({
                type: "slack",
                label: "Slack",
                description: "test double",
                credentials: slackLike.credentialFields,
                test: () =>
                  Promise.resolve(() =>
                    Promise.resolve({
                      success: false,
                      error: "from the definition",
                    })
                  ),
                actions: {},
              }),
            ],
          })
        );
        registerIntegrationTest("slack", () =>
          Promise.resolve(() =>
            Promise.resolve({ success: false, error: "from the registration" })
          )
        );
        const repo = makeIntegrationRepo(storedSlackIntegration);

        const answer = yield* postIntegrationTest("int_1").pipe(
          Effect.provide(repo.layer)
        );

        assert.strictEqual(answer.status, "error");
        assert.strictEqual(answer.message, "from the definition");
      })
    );

    it.effect(
      "answers with the database message when the row cannot be read",
      () =>
        Effect.gen(function* () {
          const failure = yield* postIntegrationTest("int_1").pipe(
            Effect.provide(unreadableIntegrationRepo),
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
