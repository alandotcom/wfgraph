/**
 * `ExecutionRepo.fenced` over SQLite: the same writes the PostgreSQL backend
 * fences (`services/executions/repo/fenced-writes.ts`), each run inside one
 * `BEGIN IMMEDIATE` transaction after its schedule row check.
 */

import { Effect } from "effect";
import type {
  FencedExecutionWrites,
  OwnerFence,
} from "#src/backend/services/executions/repo";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import { recordAuditEventWrite } from "#src/backend/persistence/sqlite/executions/audit";
import {
  cancelOpenNodeLogsWrite,
  closeNodeLogWrite,
  openNodeLogWrite,
} from "#src/backend/persistence/sqlite/executions/logs";
import {
  finishRunWrite,
  markRunningWrite,
  markWaitingIfParkedWrite,
  requestExitWrite,
} from "#src/backend/persistence/sqlite/executions/runs";
import {
  makeSqlitePassWrites,
  resolveOpenParks,
  writeFenced,
} from "#src/backend/persistence/sqlite/executions/schedule";
import {
  cancelWaitsForExecutionWrite,
  markWaitStatusWrite,
  reparkWaitWrite,
  settleWaitTimeoutWrite,
  startWaitWrite,
} from "#src/backend/persistence/sqlite/executions/waits";

export function makeSqliteFencedWrites(
  store: SqliteDatabase
): (fence: OwnerFence) => FencedExecutionWrites {
  return (fence) => ({
    ...makeSqlitePassWrites(store, fence),
    openNodeLog: (input) => writeFenced(store, fence, openNodeLogWrite(input)),
    closeNodeLog: (input) =>
      writeFenced(store, fence, closeNodeLogWrite(input, fence)),
    cancelOpenNodeLogs: (executionId) =>
      writeFenced(store, fence, cancelOpenNodeLogsWrite(executionId)),
    recordAuditEvent: (input) =>
      writeFenced(store, fence, recordAuditEventWrite(input)),
    startWait: (input) => writeFenced(store, fence, startWaitWrite(input)),
    reparkWait: (input) =>
      writeFenced(store, fence, reparkWaitWrite(input, fence)),
    markWaitStatus: (input) =>
      writeFenced(store, fence, markWaitStatusWrite(input, fence)),
    settleWaitTimeout: (waitStateId) =>
      writeFenced(store, fence, settleWaitTimeoutWrite(waitStateId, fence)),
    cancelWaitsForExecution: (executionId) =>
      writeFenced(store, fence, cancelWaitsForExecutionWrite(executionId)),
    markRunning: (input) => writeFenced(store, fence, markRunningWrite(input)),
    markWaitingIfParked: (input) =>
      writeFenced(store, fence, markWaitingIfParkedWrite(input)),
    // The pass that wins the Exit claim resolves the run's other parks in the
    // same transaction, so a parked sibling halts on the next pass rather than
    // holding the run until its own deadline.
    requestExit: (input) =>
      writeFenced(store, fence, (database) =>
        Effect.gen(function* () {
          const state = yield* requestExitWrite(input)(database);
          if (state?.didWrite) {
            yield* resolveOpenParks(database, input.executionId, {
              kind: "exit",
            });
          }
          return state;
        })
      ),
    finishRun: (input) => writeFenced(store, fence, finishRunWrite(input)),
  });
}
