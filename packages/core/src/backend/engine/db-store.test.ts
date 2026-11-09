/**
 * The adapter hands a verdict to the repository's `endRun` and preserves its
 * answer and its `DatabaseError` for `recordVerdict`, and skips the log writes
 * the log rows it was handed show would change nothing.
 */

import { Effect } from "effect";
import { describe, expect, layer } from "@effect/vitest";
// The mocks API has to be the one vitest itself exports.
import { vi } from "vitest";
import { createDbWorkflowStore } from "#src/backend/engine/db-store";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { stubExecutionRepo } from "#src/backend/lib/effect/test-layers";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { nodeLogId } from "#src/backend/services/executions/repo/node-logs";

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
          logRows: [],
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
            logRows: [],
          }).completeRun(terminalWrite)
        );

        expect(error).toBeInstanceOf(DatabaseError);
      })
    );
  });
});

describe("the log writes", () => {
  const opens: string[] = [];
  const closes: string[] = [];
  const startedAt = new Date("2026-03-01T09:00:00.000Z");
  const logIdOf = (nodeId: string) => nodeLogId("exec_1", nodeId);

  // Every read the stub is not given dies, so a store that read the log rows
  // again would fail the case.
  layer(
    stubExecutionRepo({
      openNodeLog: (input) =>
        Effect.sync(() => {
          opens.push(input.nodeId);
          return logIdOf(input.nodeId);
        }),
      closeNodeLog: (input) =>
        Effect.sync(() => {
          closes.push(`${input.logId}:${input.status}`);
        }),
    })
  )((it) => {
    it.effect(
      "skips an open for a node that has a row and a close the close rule refuses, and keeps its own writes",
      () =>
        Effect.gen(function* () {
          const repo = yield* ExecutionRepo;
          // What earlier passes left: a node closed as a success, one closed
          // as an error, and one left running.
          const store = createDbWorkflowStore({
            executionId: "exec_1",
            reads: repo,
            writes: repo,
            logRows: [
              { id: logIdOf("succeeded"), status: "success", startedAt },
              { id: logIdOf("failed"), status: "error", startedAt },
              { id: logIdOf("running"), status: "running", startedAt },
            ],
          });
          const closeWith = (nodeId: string, status: "success" | "error") =>
            store.completeStepLog({
              logId: logIdOf(nodeId),
              status,
              durationMs: 1,
            });

          const handles = yield* Effect.forEach(
            ["succeeded", "running", "fresh"],
            (nodeId) =>
              store.startStepLog({
                executionId: "exec_1",
                nodeId,
                nodeName: nodeId,
                nodeType: "action",
              })
          );
          yield* closeWith("succeeded", "error");
          yield* closeWith("failed", "error");
          yield* closeWith("failed", "success");
          yield* closeWith("running", "success");
          yield* closeWith("fresh", "error");
          // The store's own close made `fresh` an error, so a second error
          // close is skipped as well.
          yield* closeWith("fresh", "error");

          expect(opens).toEqual(["fresh"]);
          expect(closes).toEqual([
            `${logIdOf("failed")}:success`,
            `${logIdOf("running")}:success`,
            `${logIdOf("fresh")}:error`,
          ]);
          expect(handles.map((handle) => handle.logId)).toEqual(
            ["succeeded", "running", "fresh"].map(logIdOf)
          );
          // A row the store found answers when it was opened; the row the
          // store inserted answers when this pass opened it.
          expect(handles.map((handle) => handle.startTime)).toEqual([
            startedAt.getTime(),
            startedAt.getTime(),
            expect.any(Number),
          ]);
          expect(handles[2]?.startTime).toBeGreaterThan(startedAt.getTime());
        })
    );
  });
});
