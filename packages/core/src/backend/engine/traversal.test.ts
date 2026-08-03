import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { Traversal } from "#src/backend/engine/traversal";

describe("Traversal.withNodeInProgress", () => {
  it.effect("admits one caller and releases the latch when work ends", () =>
    Effect.gen(function* () {
      const traversal = new Traversal([], []);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const first = yield* Effect.forkChild(
        traversal.withNodeInProgress("node_1", () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          })
        )
      );

      yield* Deferred.await(entered);
      const duplicate = yield* traversal.withNodeInProgress(
        "node_1",
        () => Effect.void
      );
      assert.isFalse(duplicate);

      yield* Deferred.succeed(release, undefined);
      assert.isTrue(yield* Fiber.join(first));

      const afterRelease = yield* traversal.withNodeInProgress(
        "node_1",
        () => Effect.void
      );
      assert.isTrue(afterRelease);
    })
  );
});
