/**
 * Repository-backed `WorkflowStore`: the adapter real runs use.
 *
 * It is the only place that knows both the engine's persistence port and the
 * repository behind it, which is what keeps the engine module free of database
 * imports. The caller supplies the reads and writes: the Inngest path passes
 * the repository's unfenced writes, and a pass of the database executor passes
 * `ExecutionRepo.fenced` for its own owner token. Every method remains an
 * Effect for the engine to compose, and database failures remain in the error
 * channel for the engine policy at the call site to interpret.
 */

import { Effect } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import type { Conflict } from "#src/backend/lib/effect/failures";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";
import type {
  ExecutionRepo,
  StoreWrites,
} from "#src/backend/services/executions/repo";
import { decodeIsoTimestampOrThrow } from "@wfgraph/shared/types/timestamp";
import type {
  CompletedNodeProgress,
  CompleteRunInput,
  ExecutionTerminationState,
  WorkflowStore,
} from "#src/backend/engine/store";
import type { ExecutionTerminationState as StoredTerminationState } from "#src/backend/services/executions/repo/contracts";
import {
  isWaitSignalType,
  WAIT_ARRIVAL_METADATA_KEY,
  type WaitArrival,
} from "@wfgraph/shared/lifecycle/wait-signal";
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";

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
    : Effect.succeed(undefined);
}

/**
 * The wake a resume claim recorded on the row, or null when it recorded none.
 *
 * The row's metadata is written by two parties: the park writes the wait's own
 * parameters and a claim adds its arrival under one key. Anything that does not
 * read back as an arrival is treated as none, because the alternative is a run
 * failing on a row a future version wrote a different shape into.
 */
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

function readWaitArrival(metadata: JsonObject | null): WaitArrival | null {
  const arrival = readJsonObject(metadata?.[WAIT_ARRIVAL_METADATA_KEY]);
  if (!arrival || !isWaitSignalType(arrival.signalType)) {
    return null;
  }
  return {
    signalType: arrival.signalType,
    eventName: typeof arrival.eventName === "string" ? arrival.eventName : null,
    payload: readJsonObject(arrival.payload) ?? {},
    deliveryId:
      typeof arrival.deliveryId === "string" ? arrival.deliveryId : undefined,
  };
}

/** The repository reads the store answers the engine's questions from. */
export type StoreReads = Pick<
  ExecutionRepo["Service"],
  | "findWaitStateById"
  | "canAdmitNode"
  | "findTerminationState"
  | "findPendingCancel"
  | "readNodeOutputs"
  | "listLogs"
>;

/**
 * A fenced write's refusal reaches the engine as a database failure, which is
 * the one failure the port carries. The pass that owns the fence has already
 * recorded that it lost the run, and ends without writing anything more.
 */
function asStoreFailure<A>(
  write: Effect.Effect<A, DatabaseError | Conflict>
): Effect.Effect<A, DatabaseError> {
  return Effect.mapError(write, (failure) =>
    failure._tag === "Conflict"
      ? new DatabaseError({ cause: failure })
      : failure
  );
}

export function createDbWorkflowStore(bound: {
  reads: StoreReads;
  writes: StoreWrites;
}): WorkflowStore {
  const { reads, writes } = bound;

  function completeRun(
    input: CompleteRunInput
  ): Effect.Effect<ExecutionTerminationState | null, DatabaseError> {
    return asStoreFailure(
      writes.finishRun({
        executionId: input.executionId,
        status: input.status,
        output: redactSensitiveData(input.output),
        error: input.failure?.message,
      })
    ).pipe(
      Effect.map((state) => (state ? engineTerminationState(state) : null))
    );
  }

  return {
    // Step payloads can carry secrets pulled in through templates, so they are
    // scrubbed here rather than at each call site - this is the last point before
    // they reach a table.
    startStepLog: (input) =>
      asStoreFailure(
        writes.openNodeLog({
          ...input,
          input: redactSensitiveData(input.input),
        })
      ).pipe(Effect.map((logId) => ({ logId, startTime: Date.now() }))),

    completeStepLog: (input) =>
      asStoreFailure(
        writes.closeNodeLog({
          logId: input.logId,
          status: input.status,
          output: redactSensitiveData(input.output),
          error: input.error,
          durationMs: input.durationMs,
        })
      ),

    recordAuditEvent: (input) => asStoreFailure(writes.recordAuditEvent(input)),

    createWaitState: ({ waitUntilIso, ...input }) =>
      Effect.flatMap(readWaitUntil(waitUntilIso), (waitUntil) =>
        asStoreFailure(writes.startWait({ ...input, waitUntil }))
      ),

    reparkWaitState: ({ waitUntilIso, ...input }) =>
      Effect.flatMap(readWaitUntil(waitUntilIso ?? undefined), (waitUntil) =>
        asStoreFailure(
          writes.reparkWait({ ...input, waitUntil: waitUntil ?? null })
        )
      ),

    readWaitState: (waitStateId) =>
      Effect.map(reads.findWaitStateById(waitStateId), (row) =>
        row
          ? { status: row.status, arrival: readWaitArrival(row.metadata) }
          : null
      ),

    markWaitStateStatus: (input) =>
      asStoreFailure(writes.markWaitStatus(input)),

    settleWaitTimeout: (waitStateId) =>
      asStoreFailure(writes.settleWaitTimeout(waitStateId)),

    markExecutionRunning: (input) => asStoreFailure(writes.markRunning(input)),

    markExecutionWaitingIfParked: (input) =>
      asStoreFailure(writes.markWaitingIfParked(input)),

    admitNode: (executionId) => reads.canAdmitNode(executionId),

    requestExit: (input) =>
      asStoreFailure(
        writes.requestExit({
          executionId: input.executionId,
          reason: input.reason,
          nodeId: input.nodeId,
          requestedAt: decodeIsoTimestampOrThrow(input.checkedAt),
        })
      ).pipe(
        Effect.map((state) => (state ? engineTerminationState(state) : null))
      ),

    readTerminationState: (executionId) =>
      reads
        .findTerminationState(executionId)
        .pipe(
          Effect.map((state) => (state ? engineTerminationState(state) : null))
        ),

    readPendingCancel: (executionId) => reads.findPendingCancel(executionId),

    readNodeOutputs: (executionId) => reads.readNodeOutputs(executionId),

    readCompletedNodeProgress: (executionId) =>
      reads.listLogs(executionId).pipe(
        Effect.map((logs) => {
          const latestByNode = new Map<string, CompletedNodeProgress>();
          for (const log of logs) {
            if (
              latestByNode.has(log.nodeId) ||
              (log.status !== "success" && log.status !== "error")
            ) {
              continue;
            }

            latestByNode.set(log.nodeId, {
              nodeId: log.nodeId,
              nodeName: log.nodeName,
              status: log.status,
              output: log.output ?? null,
              error: log.error,
            });
          }
          return [...latestByNode.values()];
        })
      ),

    // Two statements, because the rows a killed branch leaves open are of two
    // kinds and each table decides for itself which of its rows are still open.
    // Neither reads the other, so they go together rather than in an order.
    cancelOpenWork: ({ executionId }) =>
      Effect.asVoid(
        Effect.all(
          [
            asStoreFailure(writes.cancelOpenNodeLogs(executionId)),
            asStoreFailure(writes.cancelWaitsForExecution(executionId)),
          ],
          { concurrency: 2 }
        )
      ),

    completeRun,
  };
}
