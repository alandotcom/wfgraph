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

describe("Traversal.inheritStoredOutputs", () => {
  it.effect("preserves an Arriving Event already owned by the branch", () =>
    Effect.sync(() => {
      const node: WorkflowNode = {
        id: "lifecycle_1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: "Lifecycle", type: "lifecycle", config: {} },
      };
      const traversal = new Traversal([node], []);
      traversal.setOwnOutput(node.id, {
        label: "Lifecycle",
        data: { event: "current" },
      });
      traversal.inheritStoredOutputs(
        { lifecycle_1: { event: "stale" } },
        "wait_1"
      );
      assert.deepStrictEqual(traversal.ownOutputs.lifecycle_1?.data, {
        event: "current",
      });
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
    "keeps a __proto__ failure enumerable through every result merge",
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
        const branchResult = {
          results: { ...completed.results },
          outputs: {},
        };
        const parent = new Traversal([], []);
        parent.absorbBranch(branchResult);

        assert.isTrue(Object.hasOwn(parent.results, "__proto__"));
        assert.equal(Object.getPrototypeOf(parent.results), Object.prototype);
        assert.equal(parent.resultCount, 1);
        assert.isFalse(parent.allSucceeded());
        assert.deepStrictEqual(parent.firstFailure(), failure.error);
      })
  );
});
