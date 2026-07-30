/**
 * Postgres-backed `WorkflowStore`: the adapter real runs use.
 *
 * It is the only place that knows both the engine's persistence port and the
 * repository behind it, which is what keeps the engine module free of database
 * imports. The engine speaks Promises, so each method runs its Effect on the
 * app's runtime; a refused query arrives back as a rejection, which is what the
 * calling step already expects.
 */

import { Effect } from "effect";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import { getAppLogger } from "#src/backend/lib/logger";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";
import type { RovaRuntime } from "#src/backend/runtime";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo/index";
import { decodeIsoTimestampOrThrow } from "@rova/shared/types/timestamp";
import type { CompleteRunInput, WorkflowStore } from "./store";

const storeLogger = getAppLogger("workflow", "db-store");

export function createDbWorkflowStore(runtime: RovaRuntime): WorkflowStore {
  const onRepo = <A>(
    use: (repo: ExecutionRepo["Service"]) => Effect.Effect<A, DatabaseError>
  ): Promise<A> => runtime.runPromise(Effect.flatMap(ExecutionRepo, use));

  /**
   * Writes the run's terminal row, and says whether this write is the one that
   * recorded it.
   *
   * A transient write failure says nothing about who owns the terminal status,
   * so the caller still announces its own outcome; a row already terminal is a
   * cancellation that won the race, and that one the caller must not overwrite
   * in the timeline either.
   */
  async function completeRun(input: CompleteRunInput): Promise<boolean> {
    try {
      const recorded = await onRepo((repo) =>
        repo.finishRun({
          executionId: input.executionId,
          status: input.status,
          output: redactSensitiveData(input.output),
          error: input.error,
          durationMs: Date.now() - input.startTime,
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
      storeLogger.warn("Failed to log workflow completion", {
        executionId: input.executionId,
        status: input.status,
        error,
      });
      return true;
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
          durationMs: Date.now() - input.startTime,
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

    completeRun,
  };
}
