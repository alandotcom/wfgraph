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
import type { WorkflowExecutionLog } from "#src/backend/services/executions/repo/contracts";

const terminalWrite = {
  executionId: "exec_1",
  status: "completed",
  output: { ok: true },
} as const;

describe("completeRun", () => {
  layer(
    stubExecutionRepo({
      finishRun: () =>
        Effect.succeed({
          executionId: "exec_1",
          status: "completed",
          claim: null,
          didWrite: true,
        }),
    })
  )((it) => {
    it.effect("answers the claimed terminal state", () =>
      Effect.gen(function* () {
        const repo = yield* ExecutionRepo;
        const result =
          yield* createDbWorkflowStore(repo).completeRun(terminalWrite);

        expect(result).toEqual({
          status: "completed",
          claim: null,
          didWrite: true,
        });
      })
    );
  });

  layer(
    stubExecutionRepo({
      finishRun: () =>
        Effect.succeed({
          executionId: "exec_1",
          status: "canceled",
          claim: null,
          didWrite: false,
        }),
    })
  )((it) => {
    it.effect(
      "answers the authoritative state when another terminal status won",
      () =>
        Effect.gen(function* () {
          const repo = yield* ExecutionRepo;
          const result =
            yield* createDbWorkflowStore(repo).completeRun(terminalWrite);

          expect(result).toEqual({
            status: "canceled",
            claim: null,
            didWrite: false,
          });
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

describe("readCompletedNodeProgress", () => {
  const timestamp = new Date("2026-09-22T12:00:00.000Z");
  const log = (
    input: Partial<WorkflowExecutionLog> &
      Pick<WorkflowExecutionLog, "id" | "nodeId" | "status">
  ): WorkflowExecutionLog => ({
    id: input.id,
    executionId: "exec_1",
    nodeId: input.nodeId,
    nodeName: input.nodeName ?? input.nodeId,
    nodeType: "action",
    status: input.status,
    input: null,
    output: input.output ?? null,
    error: input.error ?? null,
    startedAt: timestamp,
    completedAt: timestamp,
    duration: "1",
    timestamp,
  });

  layer(
    stubExecutionRepo({
      // `listLogs` promises newest first. Incomplete rows do not displace a
      // completed result, and the first terminal row per node is authoritative.
      listLogs: () =>
        Effect.succeed([
          log({
            id: "new-success",
            nodeId: "success-node",
            nodeName: "Latest success",
            status: "success",
            output: { marker: "latest" },
          }),
          log({ id: "running", nodeId: "running-node", status: "running" }),
          log({
            id: "new-error",
            nodeId: "error-node",
            status: "error",
            error: "latest error",
          }),
          log({
            id: "cancelled",
            nodeId: "cancelled-node",
            status: "cancelled",
          }),
          log({
            id: "old-success",
            nodeId: "success-node",
            status: "success",
            output: { marker: "old" },
          }),
          log({
            id: "old-error",
            nodeId: "error-node",
            status: "error",
            error: "old error",
          }),
        ]),
    })
  )((it) => {
    it.effect("returns only each node's newest terminal result", () =>
      Effect.gen(function* () {
        const repo = yield* ExecutionRepo;
        const result =
          yield* createDbWorkflowStore(repo).readCompletedNodeProgress(
            "exec_1"
          );

        expect(result).toEqual([
          {
            nodeId: "success-node",
            nodeName: "Latest success",
            status: "success",
            output: { marker: "latest" },
            error: null,
          },
          {
            nodeId: "error-node",
            nodeName: "error-node",
            status: "error",
            output: null,
            error: "latest error",
          },
        ]);
      })
    );
  });
});
