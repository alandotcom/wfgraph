/**
 * The repository answers `completeRun` with a claimed row, a lost race, or a
 * `DatabaseError`. The adapter preserves all three for terminal-record policy.
 */

import { Effect } from "effect";
import { describe, expect, layer } from "@effect/vitest";
import { createDbWorkflowStore } from "#src/backend/engine/db-store";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { stubExecutionRepo } from "#src/backend/lib/effect/test-layers";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

const terminalWrite = {
  executionId: "exec_1",
  status: "completed",
  output: { ok: true },
} as const;

describe("completeRun", () => {
  layer(stubExecutionRepo({ finishRun: () => Effect.succeed(true) }))((it) => {
    it.effect("answers true when the write claimed the row", () =>
      Effect.gen(function* () {
        const repo = yield* ExecutionRepo;
        const result =
          yield* createDbWorkflowStore(repo).completeRun(terminalWrite);

        expect(result).toBe(true);
      })
    );
  });

  layer(stubExecutionRepo({ finishRun: () => Effect.succeed(false) }))((it) => {
    it.effect(
      "answers false when an earlier terminal status holds the row",
      () =>
        Effect.gen(function* () {
          const repo = yield* ExecutionRepo;
          const result =
            yield* createDbWorkflowStore(repo).completeRun(terminalWrite);

          expect(result).toBe(false);
        })
    );
  });

  layer(
    stubExecutionRepo({
      finishRun: () =>
        Effect.fail(new DatabaseError({ cause: new Error("no connection") })),
    })
  )((it) => {
    it.effect("preserves DatabaseError when the query is refused", () =>
      Effect.gen(function* () {
        const repo = yield* ExecutionRepo;
        const error = yield* Effect.flip(
          createDbWorkflowStore(repo).completeRun(terminalWrite)
        );

        expect(error).toBeInstanceOf(DatabaseError);
      })
    );
  });
});
