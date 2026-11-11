/**
 * Repository-backed `WorkflowStore`: the adapter real runs use.
 *
 * It is the only place that knows both the engine's persistence port and the
 * repository behind it, which is what keeps the engine module free of database
 * imports. The caller supplies the run and its reads and writes: a pass of the
 * database executor passes the writes of `ExecutionRepo.fenced` for its own
 * owner token, and a test may pass the repository's unfenced writes. Every
 * method remains an Effect for the engine to compose. Database failures, and
 * the `LeaseLost` a fenced write answers once the pass no longer holds the run,
 * remain in the error channel for the engine policy at the call site to
 * interpret.
 */

import { Effect } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";
import type {
  ExecutionRepo,
  ParkWake,
  StoreWrites,
} from "#src/backend/services/executions/repo";
import {
  type NodeLogState,
  nodeLogId,
} from "#src/backend/services/executions/repo/node-logs";
import { nodeLogCloseApplies } from "#src/backend/services/executions/repo/node-log-close";
import type { WaitWake } from "#src/backend/engine/runtime";
import { decodeIsoTimestampOrThrow } from "@wfgraph/shared/types/timestamp";
import { isoTerminationClaim } from "@wfgraph/shared/lifecycle/execution-contracts";
import type {
  ExecutionTerminationState,
  WorkflowStore,
} from "#src/backend/engine/store";
import type { ExecutionTerminationState as StoredTerminationState } from "#src/backend/services/executions/repo/contracts";

/**
 * The port speaks ISO strings so wait-state writes stay JSON-safe across a
 * memoized step; the table wants a Date.
 */
function readWaitUntil(
  waitUntilIso: string | undefined
): Effect.Effect<Date | undefined, DatabaseError> {
  return waitUntilIso
    ? Effect.try({
        try: () => decodeIsoTimestampOrThrow(waitUntilIso),
        catch: (cause) => new DatabaseError({ cause }),
      })
    : Effect.undefined;
}

/** A stored claim and status as the engine's port reads them, with ISO timestamps. */
function engineTerminationState(
  state: StoredTerminationState
): ExecutionTerminationState {
  return {
    status: state.status,
    claim: state.claim && isoTerminationClaim(state.claim),
    didWrite: state.didWrite,
  };
}

/**
 * A park's stored wake as the engine reads it. The delivery that carried an
 * Event is the row's own bookkeeping, so the engine's wake leaves it out.
 */
function engineWake(wake: ParkWake): WaitWake {
  if (wake.kind === "resume") {
    return {
      kind: "resume",
      eventName: wake.eventName,
      payload: wake.payload,
    };
  }
  return wake;
}

/** The repository reads the store answers the engine's questions from. */
export type StoreReads = Pick<
  ExecutionRepo["Service"],
  | "findWaitStateById"
  | "findPark"
  | "canAdmitNode"
  | "findTerminationState"
  | "findPendingCancel"
>;

/**
 * The store of one run, `executionId`, which a pass builds afresh. Its log
 * writes skip what would change nothing, judged from `logRows`: an open for a
 * node that has a row, and a close `nodeLogCloseApplies` refuses. A skipped
 * open answers the row's own `startedAt`, so a Wait's close measures the park
 * from when its row was first opened.
 */
export function createDbWorkflowStore(bound: {
  executionId: string;
  reads: StoreReads;
  writes: StoreWrites;
  /** The run's log rows, as the pass read them when it opened. */
  logRows: readonly NodeLogState[];
}): WorkflowStore {
  const { reads, writes } = bound;
  // Each log row's status and opening time by row id, kept current by the
  // store's own log writes. Only the pass holding the run's lease writes its
  // log rows, so it stays exact while the pass runs, but it is a hint for
  // skipping writes: the guard each write carries in SQL is the authority.
  const logRows = new Map(
    bound.logRows.map(({ id, status, startedAt }) => [
      id,
      { status, startedAt },
    ])
  );

  return {
    // Step payloads can carry secrets pulled in through templates, so they are
    // scrubbed here rather than at each call site - this is the last point before
    // they reach a table.
    startStepLog: (input) =>
      Effect.gen(function* () {
        const logId = nodeLogId(bound.executionId, input.nodeId);
        const row = logRows.get(logId);
        if (row !== undefined) {
          return {
            logId,
            startTime: row.startedAt.getTime(),
            finishedBefore: row.status === "success",
          };
        }
        yield* writes.openNodeLog({
          ...input,
          executionId: bound.executionId,
          input: redactSensitiveData(input.input),
        });
        const startedAt = new Date();
        logRows.set(logId, { status: "running", startedAt });
        return {
          logId,
          startTime: startedAt.getTime(),
          finishedBefore: false,
        };
      }),

    completeStepLog: (input) =>
      Effect.gen(function* () {
        // A row the pass did not read or open falls through to the write,
        // whose guard decides.
        const row = logRows.get(input.logId);
        if (
          row !== undefined &&
          !nodeLogCloseApplies(row.status, input.status)
        ) {
          return;
        }
        yield* writes.closeNodeLog({
          logId: input.logId,
          status: input.status,
          output: redactSensitiveData(input.output),
          error: input.error,
          durationMs: input.durationMs,
        });
        if (row !== undefined) {
          logRows.set(input.logId, { ...row, status: input.status });
        }
      }),

    recordAuditEvent: (input) => writes.recordAuditEvent(input),

    createWaitState: ({ waitUntilIso, ...input }) =>
      Effect.flatMap(readWaitUntil(waitUntilIso), (waitUntil) =>
        writes.startWait({ ...input, waitUntil })
      ),

    reparkWaitState: ({ waitUntilIso, ...input }) =>
      Effect.flatMap(readWaitUntil(waitUntilIso ?? undefined), (waitUntil) =>
        writes.reparkWait({ ...input, waitUntil: waitUntil ?? null })
      ),

    // Two reads: `findWaitStateById` leaves out the database executor's own
    // columns, which `findPark` holds. The wake is read second, so a wake a
    // producer writes between the two reads is still seen.
    readWaitState: (waitStateId) =>
      Effect.gen(function* () {
        const row = yield* reads.findWaitStateById(waitStateId);
        if (!row) return null;
        const park = yield* reads.findPark(waitStateId);
        return {
          status: row.status,
          wake: park?.wake ? engineWake(park.wake) : null,
        };
      }),

    markWaitStateStatus: (input) => writes.markWaitStatus(input),

    settleWaitTimeout: (waitStateId) => writes.settleWaitTimeout(waitStateId),

    markExecutionRunning: (input) => writes.markRunning(input),

    markExecutionWaitingIfParked: (input) => writes.markWaitingIfParked(input),

    admitNode: (executionId) => reads.canAdmitNode(executionId),

    requestExit: (input) =>
      writes
        .requestExit({
          executionId: input.executionId,
          reason: input.reason,
          nodeId: input.nodeId,
          requestedAt: decodeIsoTimestampOrThrow(input.checkedAt),
        })
        .pipe(
          Effect.map((state) => (state ? engineTerminationState(state) : null))
        ),

    readTerminationState: (executionId) =>
      reads
        .findTerminationState(executionId)
        .pipe(
          Effect.map((state) => (state ? engineTerminationState(state) : null))
        ),

    readPendingCancel: (executionId) => reads.findPendingCancel(executionId),

    completeRun: ({ executionId, verdict, output }) =>
      writes.endRun({ executionId, ending: verdict, output }),
  };
}
