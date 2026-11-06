import { assert, describe, it } from "@effect/vitest";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { Deferred, Effect, Fiber } from "effect";
import { engineFailure } from "#src/backend/engine/engine-failure";
import { Traversal } from "#src/backend/engine/traversal";

describe("Traversal.withNodeInProgress", () => {
  it.effect(
    "refuses a node completed while its scheduler was awaiting admission",
    () =>
      Effect.gen(function* () {
        const traversal = new Traversal([], []);
        traversal.markCompleted("join", { success: true, data: {} });
        const ran = yield* traversal.withNodeInProgress("join", () =>
          Effect.die("completed node ran again")
        );
        assert.isFalse(ran);
      })
  );
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

describe("Traversal.deterministicTerminalOutput", () => {
  function node(id: string): WorkflowNode {
    return {
      id,
      type: "action",
      position: { x: 0, y: 0 },
      data: { label: id, type: "action", config: {} },
    };
  }

  it.effect("breaks a tie between two terminal nodes on code-unit order", () =>
    Effect.sync(() => {
      // Code-unit order puts every capital ahead of every lowercase letter,
      // which is what makes the answer independent of the machine's locale.
      const traversal = new Traversal([node("ax_1"), node("Bx_1")], []);
      for (const id of ["ax_1", "Bx_1"]) {
        traversal.markCompleted(
          id,
          { success: true, data: { from: id } },
          { label: id, data: { from: id } }
        );
      }

      assert.deepStrictEqual(traversal.deterministicTerminalOutput(), {
        from: "Bx_1",
      });
    })
  );
});

describe("Traversal result keys", () => {
  it.effect(
    "keeps a __proto__ failure enumerable through every result write",
    () =>
      Effect.sync(() => {
        const failure = {
          success: false as const,
          error: engineFailure("failure", "Action failed"),
        };

        const recorded = new Traversal([], []);
        recorded.recordResult("__proto__", failure);

        assert.isTrue(Object.hasOwn(recorded.results, "__proto__"));
        assert.equal(Object.getPrototypeOf(recorded.results), Object.prototype);
        assert.equal(recorded.resultCount, 1);
        assert.isFalse(recorded.allSucceeded());
        assert.deepStrictEqual(recorded.firstFailure(), failure.error);

        const completed = new Traversal([], []);
        completed.markCompleted("__proto__", failure);

        assert.isTrue(Object.hasOwn(completed.results, "__proto__"));
        assert.equal(
          Object.getPrototypeOf(completed.results),
          Object.prototype
        );
        assert.equal(completed.resultCount, 1);
        assert.isFalse(completed.allSucceeded());
        assert.deepStrictEqual(completed.firstFailure(), failure.error);
      })
  );
});
