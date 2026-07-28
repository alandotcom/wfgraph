import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/database";
import { NotFound } from "#src/backend/lib/effect/failures";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo";

type NodeStatus = {
  nodeId: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
};

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = (executionId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "execution-status").with({ executionId })
  );

export const getExecutionStatus = Effect.fn("getExecutionStatus")(
  function* (executionId: string) {
    const repo = yield* ExecutionRepo;
    const logger = yield* loggerFor(executionId);

    const execution = yield* repo.findStatusById(executionId);

    if (!execution) {
      yield* logger.warn("Execution not found for status");
      return yield* Effect.fail(new NotFound({ error: "Execution not found" }));
    }

    const logs = yield* repo.listNodeStatuses(executionId);

    // A cancelled run leaves its unfinished nodes recorded as pending or
    // running, because nothing writes to them once the run stops. The editor
    // draws them as cancelled, so that is what it is told.
    const nodeStatuses: NodeStatus[] = logs.map((log) => ({
      nodeId: log.nodeId,
      status:
        execution.status === "cancelled" &&
        (log.status === "pending" || log.status === "running")
          ? "cancelled"
          : log.status,
    }));

    return {
      status: execution.status,
      nodeStatuses,
    };
  },
  (effect, executionId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(executionId),
          "Failed to get execution status"
        )
      )
    )
);
