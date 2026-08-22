import { assert, describe, it } from "@effect/vitest";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
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

describe("Traversal.setOwnOutput", () => {
  it.effect(
    "takes ownership of an inherited output so ownOutputs includes the write",
    () =>
      Effect.sync(() => {
        const node: WorkflowNode = {
          id: "lifecycle_1",
          type: "lifecycle",
          position: { x: 0, y: 0 },
          data: { label: "Lifecycle", type: "lifecycle", config: {} },
        };
        const traversal = new Traversal([node], []);
        traversal.inheritCompleted("lifecycle_1", {
          label: "Lifecycle",
          data: { appointmentId: "appt_1" },
        });
        assert.deepStrictEqual(traversal.ownOutputs, {});
        traversal.setOwnOutput("lifecycle_1", {
          label: "Lifecycle",
          data: { amount: "40" },
        });
        assert.deepStrictEqual(traversal.ownOutputs.lifecycle_1?.data, {
          amount: "40",
        });
      })
  );
});
