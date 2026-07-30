/**
 * Postgres-backed `WorkflowStore`: the adapter real runs use.
 *
 * It is the only place that knows both the engine's persistence port and the
 * database helpers behind it, which is what keeps the engine module free of db
 * imports. Every method is a thin translation, with one exception: `completeRun`
 * decides what a failed write means to a caller, since the port answers whether
 * this write recorded the terminal status.
 */

import { getAppLogger } from "#src/backend/lib/logger";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";
import { logWorkflowAuditEvent } from "#src/backend/lib/workflow-audit";
import {
  logStepCompleteDb,
  logStepStartDb,
  logWorkflowCompleteDb,
} from "#src/backend/lib/workflow-logging";
import {
  createWaitState,
  markExecutionRunning,
  markWaitStateStatus,
} from "#src/backend/lib/workflow-wait-state";
import { decodeIsoTimestampOrThrow } from "@rova/shared/types/timestamp";
import type { CompleteRunInput, WorkflowStore } from "./store";

const storeLogger = getAppLogger("workflow", "db-store");

/**
 * Writes the run's terminal row, and says whether this write is the one that
 * recorded it.
 *
 * A transient write failure says nothing about who owns the terminal status, so
 * the caller still announces its own outcome; a row already terminal is a
 * cancellation that won the race, and that one the caller must not overwrite in
 * the timeline either.
 */
async function completeRun(input: CompleteRunInput): Promise<boolean> {
  try {
    const recorded = await logWorkflowCompleteDb({
      ...input,
      output: redactSensitiveData(input.output),
    });

    if (!recorded) {
      storeLogger.info(
        "Run completion superseded by an earlier terminal status",
        { executionId: input.executionId, status: input.status }
      );
    }

    return recorded;
  } catch (error) {
    storeLogger.warn("Failed to log workflow completion", {
      executionId: input.executionId,
      status: input.status,
      error,
    });
    return true;
  }
}

export const dbWorkflowStore: WorkflowStore = {
  // Step payloads can carry secrets pulled in through templates, so they are
  // scrubbed here rather than at each call site - this is the last point before
  // they reach a table.
  startStepLog: (input) =>
    logStepStartDb({ ...input, input: redactSensitiveData(input.input) }),

  completeStepLog: (input) =>
    logStepCompleteDb({ ...input, output: redactSensitiveData(input.output) }),

  recordAuditEvent: (input) => logWorkflowAuditEvent(input),

  createWaitState: async (input) => {
    // The port speaks ISO strings so wait-state writes stay JSON-safe across a
    // memoized step; the table wants a Date. The engine produced this string
    // through the same codec, so a string that will not decode means the value
    // was corrupted in between, and the write fails rather than storing a wait
    // target nothing can resume from.
    const waitState = await createWaitState({
      ...input,
      waitUntil: input.waitUntilIso
        ? decodeIsoTimestampOrThrow(input.waitUntilIso)
        : undefined,
    });

    return waitState ? { waitStateId: waitState.id } : undefined;
  },

  markWaitStateStatus: async (input) => {
    await markWaitStateStatus(input);
  },

  markExecutionRunning: async (input) => {
    await markExecutionRunning(input.executionId);
  },

  completeRun,
};
