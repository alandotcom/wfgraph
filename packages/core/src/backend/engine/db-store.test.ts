/**
 * The adapter hands a verdict to the repository's `endRun` and preserves its
 * answer and its `DatabaseError` for `recordVerdict`.
 */

import { Effect } from "effect";
import { describe, expect, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports.
import { vi } from "vitest";
import { createDbWorkflowStore } from "#src/backend/engine/db-store";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { stubExecutionRepo } from "#src/backend/lib/effect/test-layers";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

const terminalWrite = {
  executionId: "exec_1",
  verdict: {
    kind: "verdict",
    status: "completed",
    reached: { kind: "walked", resultCount: 1 },
  },
  output: { ok: true },
} as const;

describe("completeRun", () => {
  const endRun = vi.fn<ExecutionRepo["Service"]["endRun"]>(() =>
    Effect.succeed({ kind: "ended", status: "completed" } as const)
  );

  layer(stubExecutionRepo({ endRun }))((it) => {
    it.effect("hands the verdict and output to the repository's endRun", () =>
      Effect.gen(function* () {
        const repo = yield* ExecutionRepo;
        const result = yield* createDbWorkflowStore({
          executionId: "exec_1",
          reads: repo,
          writes: repo,
        }).completeRun(terminalWrite);

        expect(result).toEqual({ kind: "ended", status: "completed" });
        expect(endRun).toHaveBeenCalledWith({
          executionId: "exec_1",
          ending: terminalWrite.verdict,
          output: { ok: true },
        });
      })
    );
  });

  layer(
    stubExecutionRepo({
      endRun: () =>
        Effect.fail(new DatabaseError({ cause: new Error("no connection") })),
    })
  )((it) => {
    it.effect("preserves DatabaseError when the query is refused", () =>
      Effect.gen(function* () {
        const repo = yield* ExecutionRepo;
        const error = yield* Effect.flip(
          createDbWorkflowStore({
            executionId: "exec_1",
            reads: repo,
            writes: repo,
          }).completeRun(terminalWrite)
        );

        expect(error).toBeInstanceOf(DatabaseError);
      })
    );
  });
});
