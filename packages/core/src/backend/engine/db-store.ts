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

import { Effect, Semaphore } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";
import type {
  ExecutionRepo,
  ParkWake,
  StoreWrites,
} from "#src/backend/services/executions/repo";
import { nodeLogId } from "#src/backend/services/executions/repo/node-logs";
import { nodeLogCloseApplies } from "#src/backend/services/executions/repo/release-policy";
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
  | "listNodeStatuses"
>;

/**
 * The status of each of the run's log rows, keyed by log id, read on the
 * first call and kept by the caller's own log writes after it. A log id is
 * derived from the run and the node (`nodeLogId`), so the key names one node.
 * Concurrent first calls share the one read, and a read that fails is tried
 * again on the next call.
 */
function logRowStatuses(input: {
  executionId: string;
  reads: StoreReads;
}): Effect.Effect<Map<string, string>, DatabaseError> {
  let statuses: Map<string, string> | undefined;
  const lock = Semaphore.makeUnsafe(1);
  return lock.withPermit(
    Effect.suspend(() =>
      statuses === undefined
        ? input.reads.listNodeStatuses(input.executionId).pipe(
            Effect.map((rows) => {
              statuses = new Map(
                rows.map((row) => [
                  nodeLogId(input.executionId, row.nodeId),
                  row.status,
                ])
              );
              return statuses;
            })
          )
        : Effect.succeed(statuses)
    )
  );
}

/**
 * The store of one run, `executionId`, which a pass builds afresh. Its log
 * writes read the run's log rows once, on the first of them, and skip what
 * would change nothing: an open for a node that has a row, and a close
 * `nodeLogCloseApplies` refuses. Only the pass holding the run's lease writes
 * its log rows, so what the store read stays exact while the pass runs. The
 * fenced close's rule applies to every close the store makes, a close the
 * pass makes unfenced after it ended the run included.
 */
export function createDbWorkflowStore(bound: {
  executionId: string;
  reads: StoreReads;
  writes: StoreWrites;
}): WorkflowStore {
  const { reads, writes } = bound;
  const logRows = logRowStatuses(bound);

  return {
    // Step payloads can carry secrets pulled in through templates, so they are
    // scrubbed here rather than at each call site - this is the last point before
    // they reach a table.
    startStepLog: (input) =>
      Effect.gen(function* () {
        const rows = yield* logRows;
        const logId = nodeLogId(input.executionId, input.nodeId);
        if (!rows.has(logId)) {
          yield* writes.openNodeLog({
            ...input,
            input: redactSensitiveData(input.input),
          });
          rows.set(logId, "running");
        }
        return { logId, startTime: Date.now() };
      }),

    completeStepLog: (input) =>
      Effect.gen(function* () {
        const rows = yield* logRows;
        const status = rows.get(input.logId);
        if (
          status === undefined ||
          !nodeLogCloseApplies(status, input.status)
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
        rows.set(input.logId, input.status);
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
