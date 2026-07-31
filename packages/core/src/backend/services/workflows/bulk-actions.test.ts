// `it` comes from the `layer` callback below, typed with the services that layer
// provides, so nothing here imports the bare one.
import { assert, describe, layer } from "@effect/vitest";
import { Effect } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  SilentAppLoggerLayer,
  stubWorkflowRepo,
} from "#src/backend/lib/effect/test-layers";
import { postWorkflowsBulkLifecycle } from "#src/backend/services/workflows/bulk-actions";

/**
 * A repository holding the workflows one test set up, and a record of what it
 * was asked to change.
 *
 * The delete branch is not stubbed out: it runs the real `deleteWorkflow`
 * against this same repository, which is the point of the batch reusing it
 * rather than deleting on its own. Built per test rather than reset between
 * them, so no test can see what another one wrote.
 *
 * `unreadable` names the workflows whose read fails the way a database that has
 * gone away does, which is how the isolation test gives one row a failure of its
 * own without touching the others.
 */
function makeWorkflowRepo(
  pausedStates: Record<string, boolean>,
  unreadable: string[] = []
) {
  const states = { ...pausedStates };
  const refused = new Set(unreadable);
  const calls = {
    pauseWrites: [] as Array<{ workflowId: string; isPaused: boolean }>,
    deletes: [] as string[],
  };

  const repoLayer = stubWorkflowRepo({
    findPausedById: (workflowId) =>
      refused.has(workflowId)
        ? Effect.fail(
            new DatabaseError({
              cause: new Error("terminating connection due to crash"),
            })
          )
        : Effect.sync(() =>
            workflowId in states
              ? { id: workflowId, isPaused: states[workflowId] }
              : null
          ),
    setPaused: (input) =>
      Effect.sync(() => {
        calls.pauseWrites.push(input);
        states[input.workflowId] = input.isPaused;
      }),
    existsById: (workflowId) => Effect.sync(() => workflowId in states),
    deleteById: (workflowId) =>
      Effect.sync(() => {
        calls.deletes.push(workflowId);
        delete states[workflowId];
      }),
  });

  return { layer: repoLayer, calls };
}

describe("postWorkflowsBulkLifecycle", () => {
  layer(SilentAppLoggerLayer)((it) => {
    it.effect("runs pause action in best-effort mode", () =>
      Effect.gen(function* () {
        const repo = makeWorkflowRepo({ wf_1: false });

        const result = yield* postWorkflowsBulkLifecycle({
          workflowIds: ["wf_1", "wf_missing"],
          action: "pause",
        }).pipe(Effect.provide(repo.layer));

        assert.deepStrictEqual(result.summary, {
          requested: 2,
          succeeded: 1,
          failed: 1,
        });
        assert.deepStrictEqual(result.results, [
          { workflowId: "wf_1", action: "pause", ok: true },
          {
            workflowId: "wf_missing",
            action: "pause",
            ok: false,
            error: "Workflow not found",
          },
        ]);
        assert.deepStrictEqual(repo.calls.pauseWrites, [
          { workflowId: "wf_1", isPaused: true },
        ]);
        assert.deepStrictEqual(repo.calls.deletes, []);
      })
    );

    it.effect("writes nothing for a workflow already in the target state", () =>
      Effect.gen(function* () {
        const repo = makeWorkflowRepo({ wf_1: true });

        const result = yield* postWorkflowsBulkLifecycle({
          workflowIds: ["wf_1"],
          action: "pause",
        }).pipe(Effect.provide(repo.layer));

        assert.deepStrictEqual(result.summary, {
          requested: 1,
          succeeded: 1,
          failed: 0,
        });
        assert.deepStrictEqual(repo.calls.pauseWrites, []);
      })
    );

    it.effect("deduplicates workflow ids and preserves delete failures", () =>
      Effect.gen(function* () {
        const repo = makeWorkflowRepo({ wf_1: false });

        const result = yield* postWorkflowsBulkLifecycle({
          workflowIds: ["wf_1", "wf_1", "wf_2"],
          action: "delete",
        }).pipe(Effect.provide(repo.layer));

        assert.deepStrictEqual(result.summary, {
          requested: 2,
          succeeded: 1,
          failed: 1,
        });
        assert.deepStrictEqual(result.results, [
          { workflowId: "wf_1", action: "delete", ok: true, deleted: true },
          {
            workflowId: "wf_2",
            action: "delete",
            ok: false,
            error: "Workflow not found",
          },
        ]);
        assert.deepStrictEqual(repo.calls.deletes, ["wf_1"]);
      })
    );

    // One unlucky row is that row's verdict and travels no further. Without the
    // per-item boundary a single refused query would fail the whole call, and
    // the caller would learn nothing about the workflows that did change.
    it.effect("keeps one workflow's refused query off the others", () =>
      Effect.gen(function* () {
        const repo = makeWorkflowRepo(
          { wf_1: false, wf_2: false, wf_3: false },
          ["wf_2"]
        );

        const result = yield* postWorkflowsBulkLifecycle({
          workflowIds: ["wf_1", "wf_2", "wf_3"],
          action: "pause",
        }).pipe(Effect.provide(repo.layer));

        assert.deepStrictEqual(result.summary, {
          requested: 3,
          succeeded: 2,
          failed: 1,
        });
        assert.deepStrictEqual(result.results, [
          { workflowId: "wf_1", action: "pause", ok: true },
          {
            workflowId: "wf_2",
            action: "pause",
            ok: false,
            error: "terminating connection due to crash",
          },
          { workflowId: "wf_3", action: "pause", ok: true },
        ]);
        // The batch runs its items concurrently, so the writes are sorted before
        // they are compared; which two happened is the assertion, not when.
        assert.deepStrictEqual(
          repo.calls.pauseWrites.map((write) => write.workflowId).sort(),
          ["wf_1", "wf_3"]
        );
      })
    );
  });
});
