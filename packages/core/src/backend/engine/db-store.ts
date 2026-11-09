/**
 * Repository-backed `WorkflowStore`: the adapter real runs use.
 *
 * It is the only place that knows both the engine's persistence port and the
 * repository behind it, which is what keeps the engine module free of database
 * imports. The caller supplies the reads and writes: a pass of the database
 * executor passes the writes of `ExecutionRepo.fenced` for its own owner token,
 * and a test may pass the repository's unfenced writes. Every method remains an
 * Effect for the engine to compose. Database failures, and the `LeaseLost` a
 * fenced write answers once the pass no longer holds the run, remain in the
 * error channel for the engine policy at the call site to interpret.
 */

import { Effect } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";
import type {
  ExecutionRepo,
  ParkWake,
  StoreWrites,
} from "#src/backend/services/executions/repo";
import type { WaitWake } from "#src/backend/engine/runtime";
import { decodeIsoTimestampOrThrow } from "@wfgraph/shared/types/timestamp";
import type {
  CompleteRunInput,
  ExecutionTerminationState,
  StoreFailure,
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
  const claim = state.claim;
  return {
    status: state.status,
    claim:
      claim?.kind === "cancel"
        ? {
            kind: "cancel",
            requestedAt: claim.requestedAt.toISOString(),
            eventName: claim.eventName,
            payload: claim.payload,
          }
        : claim?.kind === "exit"
          ? {
              kind: "exit",
              requestedAt: claim.requestedAt.toISOString(),
              reason: claim.reason,
              nodeId: claim.nodeId,
            }
          : null,
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

export function createDbWorkflowStore(bound: {
  reads: StoreReads;
  writes: StoreWrites;
}): WorkflowStore {
  const { reads, writes } = bound;

  function completeRun(
    input: CompleteRunInput
  ): Effect.Effect<ExecutionTerminationState | null, StoreFailure> {
    return writes
      .endRun({
        executionId: input.executionId,
        ending: {
          ...input.ending,
          output: redactSensitiveData(input.ending.output),
        },
      })
      .pipe(
        Effect.map((state) => (state ? engineTerminationState(state) : null))
      );
  }

  return {
    // Step payloads can carry secrets pulled in through templates, so they are
    // scrubbed here rather than at each call site - this is the last point before
    // they reach a table.
    startStepLog: (input) =>
      writes
        .openNodeLog({
          ...input,
          input: redactSensitiveData(input.input),
        })
        .pipe(Effect.map((logId) => ({ logId, startTime: Date.now() }))),

    completeStepLog: (input) =>
      writes.closeNodeLog({
        logId: input.logId,
        status: input.status,
        output: redactSensitiveData(input.output),
        error: input.error,
        durationMs: input.durationMs,
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

    completeRun,
  };
}
