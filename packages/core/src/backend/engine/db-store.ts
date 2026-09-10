/**
 * Postgres-backed `WorkflowStore`: the adapter real runs use.
 *
 * It is the only place that knows both the engine's persistence port and the
 * repository behind it, which is what keeps the engine module free of database
 * imports. The repository is resolved once when the Inngest functions are
 * assembled; every method here remains an Effect for the engine to compose.
 * Database failures remain in the error channel for the engine policy at the
 * call site to interpret.
 */

import { Effect } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";
import type { ExecutionRepo } from "#src/backend/services/executions/repo";
import { decodeIsoTimestampOrThrow } from "@wfgraph/shared/types/timestamp";
import type {
  CompleteRunInput,
  WorkflowStore,
} from "#src/backend/engine/store";
import { WAIT_ARRIVAL_METADATA_KEY } from "#src/backend/services/executions/repo/waits";
import {
  isWaitSignalType,
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
function readWaitArrival(metadata: JsonObject | null): WaitArrival | null {
  const arrival = readJsonObject(metadata?.[WAIT_ARRIVAL_METADATA_KEY]);
  if (!arrival || !isWaitSignalType(arrival.signalType)) {
    return null;
  }
  return {
    signalType: arrival.signalType,
    eventName: typeof arrival.eventName === "string" ? arrival.eventName : null,
    payload: readJsonObject(arrival.payload) ?? {},
  };
}

export function createDbWorkflowStore(
  repo: ExecutionRepo["Service"]
): WorkflowStore {
  function completeRun(
    input: CompleteRunInput
  ): Effect.Effect<boolean, DatabaseError> {
    return repo.finishRun({
      executionId: input.executionId,
      status: input.status,
      output: redactSensitiveData(input.output),
      error: input.failure?.message,
    });
  }

  return {
    // Step payloads can carry secrets pulled in through templates, so they are
    // scrubbed here rather than at each call site - this is the last point before
    // they reach a table.
    startStepLog: (input) =>
      repo
        .openNodeLog({
          ...input,
          input: redactSensitiveData(input.input),
        })
        .pipe(Effect.map((logId) => ({ logId, startTime: Date.now() }))),

    completeStepLog: (input) =>
      repo.closeNodeLog({
        logId: input.logId,
        status: input.status,
        output: redactSensitiveData(input.output),
        error: input.error,
        durationMs: input.durationMs,
      }),

    recordAuditEvent: (input) => repo.recordAuditEvent(input),

    createWaitState: ({ waitUntilIso, ...input }) =>
      Effect.flatMap(readWaitUntil(waitUntilIso), (waitUntil) =>
        repo.startWait({ ...input, waitUntil })
      ),

    reparkWaitState: ({ waitUntilIso, ...input }) =>
      Effect.flatMap(readWaitUntil(waitUntilIso ?? undefined), (waitUntil) =>
        repo.reparkWait({ ...input, waitUntil: waitUntil ?? null })
      ),

    readWaitState: (waitStateId) =>
      Effect.map(repo.findWaitStateById(waitStateId), (row) =>
        row
          ? { status: row.status, arrival: readWaitArrival(row.metadata) }
          : null
      ),

    readPinnedVersionId: (executionId) =>
      Effect.map(
        repo.findSummaryById(executionId),
        (execution) => execution?.workflowVersionId ?? null
      ),

    markWaitStateStatus: (input) => repo.markWaitStatus(input),

    markExecutionRunning: (input) => repo.markRunning(input),

    readPendingCancel: (executionId) => repo.findPendingCancel(executionId),

    readNodeOutputs: (executionId) => repo.readNodeOutputs(executionId),

    // Two statements, because the rows a killed branch leaves open are of two
    // kinds and each table decides for itself which of its rows are still open.
    // Neither reads the other, so they go together rather than in an order.
    cancelOpenWork: ({ executionId }) =>
      Effect.asVoid(
        Effect.all(
          [
            repo.cancelOpenNodeLogs(executionId),
            repo.cancelWaitsForExecution(executionId),
          ],
          { concurrency: 2 }
        )
      ),

    completeRun,
  };
}
