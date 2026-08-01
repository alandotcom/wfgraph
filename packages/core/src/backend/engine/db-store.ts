/**
 * Postgres-backed `WorkflowStore`: the adapter real runs use.
 *
 * It is the only place that knows both the engine's persistence port and the
 * repository behind it, which is what keeps the engine module free of database
 * imports. The engine speaks Promises, so each method runs its Effect on the
 * app's runtime and a refused query arrives back as a rejection, which is what
 * the calling step already expects. `completeRun` is the exception the port
 * requires: it answers rather than rejecting.
 */

import { Effect } from "effect";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import { getAppLogger } from "#src/backend/lib/logger";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";
import type { RovaRuntime } from "#src/backend/runtime";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { decodeIsoTimestampOrThrow } from "@rova/shared/types/timestamp";
import type {
  CompleteRunInput,
  WorkflowStore,
} from "#src/backend/engine/store";

const storeLogger = getAppLogger("workflow", "db-store");

export function createDbWorkflowStore(runtime: RovaRuntime): WorkflowStore {
  const onRepo = <A>(
    use: (repo: ExecutionRepo["Service"]) => Effect.Effect<A, DatabaseError>
  ): Promise<A> => runtime.runPromise(Effect.flatMap(ExecutionRepo, use));

  /**
   * The one place a refused terminal write is logged. The port's `false` answer
   * reaches the engine with the database error left behind here.
   */
  async function completeRun(input: CompleteRunInput): Promise<boolean> {
    try {
      const recorded = await onRepo((repo) =>
        repo.finishRun({
          executionId: input.executionId,
          status: input.status,
          output: redactSensitiveData(input.output),
          error: input.error,
        })
      );

      if (!recorded) {
        storeLogger.info(
          "Run completion superseded by an earlier terminal status",
          { executionId: input.executionId, status: input.status }
        );
      }

      return recorded;
    } catch (error) {
      storeLogger.warn("Terminal run record not written", {
        executionId: input.executionId,
        status: input.status,
        error,
      });
      return false;
    }
  }

  return {
    // Step payloads can carry secrets pulled in through templates, so they are
    // scrubbed here rather than at each call site - this is the last point before
    // they reach a table.
    startStepLog: async (input) => {
      const logId = await onRepo((repo) =>
        repo.openNodeLog({ ...input, input: redactSensitiveData(input.input) })
      );

      return { logId, startTime: Date.now() };
    },

    completeStepLog: async (input) => {
      await onRepo((repo) =>
        repo.closeNodeLog({
          logId: input.logId,
          status: input.status,
          output: redactSensitiveData(input.output),
          error: input.error,
          durationMs: input.durationMs,
        })
      );
    },

    recordAuditEvent: async (input) => {
      await onRepo((repo) => repo.recordAuditEvent(input));
    },

    createWaitState: ({ waitUntilIso, ...input }) =>
      onRepo((repo) =>
        repo.startWait({
          ...input,
          // The port speaks ISO strings so wait-state writes stay JSON-safe across
          // a memoized step; the table wants a Date. The engine produced this
          // string through the same codec, so a string that will not decode means
          // the value was corrupted in between, and the write fails rather than
          // storing a wait target nothing can resume from.
          waitUntil: waitUntilIso
            ? decodeIsoTimestampOrThrow(waitUntilIso)
            : undefined,
        })
      ),

    markWaitStateStatus: async (input) => {
      await onRepo((repo) => repo.markWaitStatus(input));
    },

    markExecutionRunning: async (input) => {
      await onRepo((repo) => repo.markRunning(input.executionId));
    },

    readPendingCancel: (executionId) =>
      onRepo((repo) => repo.findPendingCancel(executionId)),

    completeRun,
  };
}
