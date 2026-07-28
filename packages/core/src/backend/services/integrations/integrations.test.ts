// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { afterEach, assert, describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import {
  registerIntegrationTest,
  unregisterIntegrationTest,
} from "#src/backend/services/integrations/integration-test-loaders";
import {
  getIntegration,
  postIntegrationTest,
  putIntegration,
} from "#src/backend/services/integrations/integrations";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import {
  type IntegrationPlugin,
  registerIntegration,
  unregisterIntegration,
} from "@rova/shared/plugins/registry";
import type { IntegrationConfig } from "@rova/shared/types/integration";

/**
 * Which config keys count as secrets is read from a registered plugin, so these
 * tests register a real one rather than stubbing the registry module. The
 * registry is process-wide state that stage 6 of ADR-0002 owns; until then,
 * registering and unregistering around each test is what keeps it from leaking
 * into another file's run.
 */
const slackLike: IntegrationPlugin = {
  type: "slack",
  label: "Slack",
  description: "test double",
  formFields: [
    {
      id: "apiKey",
      label: "API Key",
      type: "password",
      configKey: "apiKey",
    },
    { id: "teamId", label: "Team ID", type: "text", configKey: "teamId" },
  ],
  actions: [],
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

  const repoLayer = Layer.succeed(IntegrationRepo, {
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
    // Secret handling never reaches the rest of the table.
    listByType: () => Effect.die("listByType is not part of secret handling"),
    insert: () => Effect.die("insert is not part of secret handling"),
    deleteById: () => Effect.die("deleteById is not part of secret handling"),
  });

  return { layer: repoLayer, calls };
}

const silentLogger: EffectLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  with: () => silentLogger,
};

// The logger fake holds no state, so it belongs to the whole block. The
// repository does, so it is built inside each test instead.
const TestAppLoggerLayer = Layer.succeed(AppLogger, {
  get: () => silentLogger,
});

describe("integration service secret handling", () => {
  afterEach(() => {
    unregisterIntegration("slack");
  });

  layer(TestAppLoggerLayer)((it) => {
    it.effect("masks secret fields in the integration it returns", () =>
      Effect.gen(function* () {
        registerIntegration(slackLike);
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
          registerIntegration(slackLike);
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
        registerIntegration(slackLike);
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
const unreadableIntegrationRepo = Layer.succeed(IntegrationRepo, {
  findById: () =>
    Effect.fail(
      new DatabaseError({
        cause: new Error("terminating connection due to administrator command"),
      })
    ),
  listByType: () => Effect.die("listByType is not part of a connection test"),
  insert: () => Effect.die("insert is not part of a connection test"),
  update: () => Effect.die("update is not part of a connection test"),
  deleteById: () => Effect.die("deleteById is not part of a connection test"),
});

/**
 * Both tests below pin the same decision: a connection test answers with the
 * message from underneath rather than the fixed sentence the other services
 * give, because the person reading it is the one who filled in the credentials
 * and only that message tells them what to change.
 */
describe("integration connection test failures", () => {
  afterEach(() => {
    unregisterIntegration("slack");
    unregisterIntegrationTest("slack");
  });

  layer(TestAppLoggerLayer)((it) => {
    it.effect("answers with what the vendor's test function threw", () =>
      Effect.gen(function* () {
        registerIntegration(slackLike);
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
