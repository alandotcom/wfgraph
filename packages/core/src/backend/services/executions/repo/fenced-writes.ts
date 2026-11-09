/**
 * `ExecutionRepo.fenced` over PostgreSQL: the writes one pass of the database
 * executor makes, each fenced on the pass's owner token.
 *
 * Every write the engine's `WorkflowStore` reaches is here, beside the writes
 * only a pass makes. Each takes the pass's schedule row first inside its own
 * transaction (`for share`, or `for update` when it changes or deletes the
 * row), then its execution and wait rows, and answers `LeaseLost` without
 * writing when the row is no longer leased under the pass's token or when the
 * write addresses another run.
 *
 * The log writes are also idempotent across a re-run of the step that made
 * them: the log open inserts a derived id and keeps the first row, and the log
 * close changes only a row that is `running` or `error`, so a re-run rewrites
 * the same values. The timeline entry is a plain insert, so a crash between a
 * store write and its memo row can leave a duplicate entry.
 */

import type { Database } from "#src/backend/lib/effect/database";
import type { RunFence } from "#src/backend/services/executions/repo/contracts";
import { recordAuditEventWrite } from "#src/backend/services/executions/repo/audit";
import {
  type FencedExecutionWrites,
  guardStoreWrites,
} from "#src/backend/services/executions/repo/fencing";
import {
  closeNodeLogWrite,
  openNodeLogWrite,
} from "#src/backend/services/executions/repo/node-logs";
import { exitWakeForClaim } from "#src/backend/services/executions/repo/release-policy";
import {
  endRunWrite,
  markRunningWrite,
  markWaitingIfParkedWrite,
  requestExitWrite,
} from "#src/backend/services/executions/repo/runs";
import {
  makeParkWrites,
  makePassWrites,
  resolveOpenParks,
  writeFenced,
  writeFencedSerializable,
} from "#src/backend/services/executions/repo/schedule";
import {
  markWaitStatusWrite,
  reparkWaitWrite,
  settleWaitTimeoutWrite,
  startWaitWrite,
} from "#src/backend/services/executions/repo/waits";

/** Builds `ExecutionRepo.fenced` over one PostgreSQL database. */
export function makeFencedWrites(
  database: Database["Service"]
): (fence: RunFence) => FencedExecutionWrites {
  return (fence) => ({
    ...makePassWrites(database, fence),
    ...makeParkWrites(database, fence),
    ...guardStoreWrites(fence, {
      openNodeLog: (input) =>
        writeFenced(database, fence, openNodeLogWrite(input)),
      closeNodeLog: (input) =>
        writeFenced(database, fence, closeNodeLogWrite(input, fence)),
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
      markRunning: (input) =>
        writeFenced(database, fence, markRunningWrite(input)),
      markWaitingIfParked: (input) =>
        writeFenced(database, fence, markWaitingIfParkedWrite(input)),
      requestExit: (input) =>
        writeFenced(database, fence, async (tx) => {
          const state = await requestExitWrite(input)(tx);
          const wake = exitWakeForClaim(state);
          if (wake !== null) {
            await resolveOpenParks(tx, [input.executionId], wake);
          }
          return state;
        }),
      // The terminal write deletes the schedule row it stands on.
      endRun: (input) =>
        writeFenced(database, fence, endRunWrite(input), "update"),
    }),
  });
}
