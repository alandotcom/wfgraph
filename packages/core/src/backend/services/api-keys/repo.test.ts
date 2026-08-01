/**
 * `touchLastUsed`'s throttle condition, pinned as the statement itself.
 *
 * Every caller stubs `ApiKeyRepo` whole, so the `WHERE` clause -- the id, the
 * null-or-stale throttle, and the UTC frame the column's timezone-naive type
 * requires -- has no other seam a test can read it through.
 */

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { stubDatabase } from "#src/backend/lib/effect/test-layers";
import {
  ApiKeyRepo,
  ApiKeyRepoLayer,
} from "#src/backend/services/api-keys/repo";

function harness() {
  const { layer: databaseLayer, statements } = stubDatabase();

  const touchLastUsed = (keyId: string): Promise<void> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* ApiKeyRepo;
        return yield* repo.touchLastUsed(keyId);
      }).pipe(
        Effect.provide(ApiKeyRepoLayer.pipe(Layer.provide(databaseLayer)))
      )
    );

  return { touchLastUsed, statements };
}

describe("touchLastUsed", () => {
  it("scopes the update to the key id, the staleness throttle, and UTC", async () => {
    const { touchLastUsed, statements } = harness();

    await touchLastUsed("key_1");

    const [statement] = statements;
    expect(statement?.query).toContain('"id" = ');
    expect(statement?.query).toContain('"last_used_at" is null');
    expect(statement?.query).toContain(
      "\"last_used_at\" < (now() at time zone 'utc') - interval '1 minute'"
    );
    expect(statement?.params).toContain("key_1");
  });
});
