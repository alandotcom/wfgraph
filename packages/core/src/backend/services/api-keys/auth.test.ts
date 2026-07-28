// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { compare, hash } from "bcryptjs";
import { Effect, Latch } from "effect";
import { Unauthorized } from "#src/backend/lib/effect/failures";
import {
  SilentAppLoggerLayer,
  stubApiKeyRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  createApiKeyRecord,
  validateApiKey,
} from "#src/backend/services/api-keys/auth";
import type { ApiKeyCandidate } from "#src/backend/services/api-keys/repo";

/**
 * A fake repository holding the keys one test stored, and a record of what it
 * was asked.
 *
 * Verification is the only thing under test here, so the database is replaced at
 * the repository boundary rather than stubbed as a module: the service asks
 * `ApiKeyRepo` a domain question and this answers it. Built per test rather than
 * reset between them, so no test can see what another one wrote.
 *
 * `touchedFirst` opens once the first last-used write lands. That write happens
 * on a fiber the service detaches and does not wait for, so a test asserting it
 * happened has to wait for it too; awaiting the latch is what makes the
 * assertion independent of when the fiber gets scheduled.
 */
function makeApiKeyRepo(candidates: ApiKeyCandidate[]) {
  const calls = {
    prefixLookups: [] as string[],
    touched: [] as string[],
    touchedFirst: Latch.makeUnsafe(),
  };

  // Verification never reads or writes the management side of the table, so
  // every other method refuses.
  const repoLayer = stubApiKeyRepo({
    findByPrefix: (keyPrefix) =>
      Effect.sync(() => {
        calls.prefixLookups.push(keyPrefix);
        return candidates;
      }),
    touchLastUsed: (keyId) =>
      Effect.sync(() => {
        calls.touched.push(keyId);
        calls.touchedFirst.openUnsafe();
      }),
  });

  return { layer: repoLayer, calls };
}

describe("api key auth", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("creates a prefixed API key with bcrypt hash", () =>
      Effect.gen(function* () {
        const record = yield* createApiKeyRecord();

        assert.isTrue(record.key.startsWith("wfb_"));
        assert.strictEqual(record.keyPrefix, record.key.slice(0, 11));
        assert.isTrue(
          yield* Effect.promise(() => compare(record.key, record.keyHash))
        );
      })
    );

    it.effect(
      "verifies API key candidates and updates lastUsedAt on success",
      () =>
        Effect.gen(function* () {
          const key = "wfb_valid_key";
          const repo = makeApiKeyRepo([
            {
              id: "k1",
              keyHash: yield* Effect.promise(() => hash("wfb_other_key", 10)),
            },
            { id: "k2", keyHash: yield* Effect.promise(() => hash(key, 10)) },
          ]);

          const result = yield* validateApiKey(`Bearer ${key}`).pipe(
            Effect.provide(repo.layer)
          );

          assert.deepStrictEqual(result, { keyId: "k2" });
          assert.deepStrictEqual(repo.calls.prefixLookups, [key.slice(0, 11)]);

          yield* repo.calls.touchedFirst.await;
          assert.deepStrictEqual(repo.calls.touched, ["k2"]);
        })
    );

    it.effect("rejects requests without auth header", () =>
      Effect.gen(function* () {
        const repo = makeApiKeyRepo([]);

        const failure = yield* validateApiKey(null).pipe(
          Effect.provide(repo.layer),
          Effect.flip
        );

        assert.instanceOf(failure, Unauthorized);
        assert.strictEqual(failure.error, "Missing Authorization header");
        assert.deepStrictEqual(repo.calls.prefixLookups, []);
      })
    );

    it.effect("rejects invalid keys", () =>
      Effect.gen(function* () {
        const repo = makeApiKeyRepo([
          { id: "k1", keyHash: yield* Effect.promise(() => hash("wfb_x", 10)) },
        ]);

        const failure = yield* validateApiKey("Bearer wfb_not_found").pipe(
          Effect.provide(repo.layer),
          Effect.flip
        );

        assert.instanceOf(failure, Unauthorized);
        assert.strictEqual(failure.error, "Invalid API key");
        assert.deepStrictEqual(repo.calls.touched, []);
      })
    );
  });
});
