/**
 * `ExecutionRepo.fenced`: the writes one pass of the database executor makes,
 * each fenced on the pass's owner token.
 *
 * Every write the engine's `WorkflowStore` reaches is here, beside the writes
 * only a pass makes. Each takes the Execution's schedule row first inside its
 * own transaction (`for share`, or `for update` when it changes or deletes the
 * row), then its execution and wait rows, and answers `LeaseLost` without
 * writing when the row is no longer leased under the pass's token.
 *
 * The log writes are also idempotent across a re-run of the step that made
 * them: the log open inserts a derived id and keeps the first row, and the log
 * close changes only a row that is `running` or `error`, so a re-run rewrites
 * the same values. The timeline entry is a plain insert, so a crash between a
 * store write and its memo row can leave a duplicate entry.
 */

import type { Database } from "#src/backend/lib/effect/database";
import type {
  FencedWrite,
  OwnerFence,
} from "#src/backend/services/executions/repo/contracts";
import { recordAuditEventWrite } from "#src/backend/services/executions/repo/audit";
import type { AuditRepoMethods } from "#src/backend/services/executions/repo/audit";
import {
  cancelOpenNodeLogsWrite,
  closeNodeLogWrite,
  type NodeLogsRepoMethods,
  openNodeLogWrite,
} from "#src/backend/services/executions/repo/node-logs";
import {
  finishRunWrite,
  markRunningWrite,
  markWaitingIfParkedWrite,
  requestExitWrite,
  type RunsRepoMethods,
} from "#src/backend/services/executions/repo/runs";
import {
  makePassWrites,
  type PassWrites,
  resolveOpenParks,
  writeFenced,
  writeFencedSerializable,
} from "#src/backend/services/executions/repo/schedule";
import {
  cancelWaitsForExecutionWrite,
  markWaitStatusWrite,
  reparkWaitWrite,
  settleWaitTimeoutWrite,
  startWaitWrite,
  type WaitsRepoMethods,
} from "#src/backend/services/executions/repo/waits";

type RepoMethods = RunsRepoMethods &
  NodeLogsRepoMethods &
  WaitsRepoMethods &
  AuditRepoMethods;

/** The repository writes the engine's `WorkflowStore` reaches. */
type StoreWriteName =
  | "openNodeLog"
  | "closeNodeLog"
  | "cancelOpenNodeLogs"
  | "recordAuditEvent"
  | "startWait"
  | "reparkWait"
  | "markWaitStatus"
  | "settleWaitTimeout"
  | "cancelWaitsForExecution"
  | "markRunning"
  | "markWaitingIfParked"
  | "requestExit"
  | "finishRun";

/**
 * The repository writes the engine's `WorkflowStore` reaches, as
 * `createDbWorkflowStore` binds them. The unfenced methods of `ExecutionRepo`
 * fill it on the Inngest path, and `ExecutionRepo.fenced` on a pass of the
 * database executor.
 */
export type StoreWrites = {
  readonly [Name in StoreWriteName]: FencedWrite<RepoMethods[Name]>;
};

/** What `ExecutionRepo.fenced` answers for one pass. */
export type FencedExecutionWrites = StoreWrites & PassWrites;

/** Builds `ExecutionRepo.fenced` over one PostgreSQL database. */
export function makeFencedWrites(
  database: Database["Service"]
): (fence: OwnerFence) => FencedExecutionWrites {
  return (fence) => ({
    ...makePassWrites(database, fence),
    openNodeLog: (input) =>
      writeFenced(database, fence, openNodeLogWrite(input)),
    closeNodeLog: (input) =>
      writeFenced(database, fence, closeNodeLogWrite(input, fence)),
    cancelOpenNodeLogs: (executionId) =>
      writeFenced(database, fence, cancelOpenNodeLogsWrite(executionId)),
    recordAuditEvent: (input) =>
      writeFenced(database, fence, recordAuditEventWrite(input)),
    startWait: (input) => writeFenced(database, fence, startWaitWrite(input)),
    reparkWait: (input) =>
      writeFenced(database, fence, reparkWaitWrite(input, fence)),
    markWaitStatus: (input) =>
      writeFenced(database, fence, markWaitStatusWrite(input, fence)),
    settleWaitTimeout: (waitStateId) =>
      writeFencedSerializable(
        database,
        fence,
        settleWaitTimeoutWrite(waitStateId, fence)
      ),
    cancelWaitsForExecution: (executionId) =>
      writeFenced(database, fence, cancelWaitsForExecutionWrite(executionId)),
    markRunning: (input) =>
      writeFenced(database, fence, markRunningWrite(input)),
    markWaitingIfParked: (input) =>
      writeFenced(database, fence, markWaitingIfParkedWrite(input)),
    // The pass that wins the Exit claim resolves the run's other parks in the
    // same transaction, so a parked sibling halts on the next pass rather than
    // holding the run until its own deadline.
    requestExit: (input) =>
      writeFenced(database, fence, async (tx) => {
        const state = await requestExitWrite(input)(tx);
        if (state?.didWrite) {
          await resolveOpenParks(tx, input.executionId, { kind: "exit" });
        }
        return state;
      }),
    // The terminal write deletes the schedule row it stands on.
    finishRun: (input) =>
      writeFenced(database, fence, finishRunWrite(input), "update"),
  });
}
