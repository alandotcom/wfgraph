import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { heldByExecutor } from "#src/backend/services/executions/executor-state";
import type { WorkflowExecutionStatus } from "@wfgraph/shared/lifecycle/execution-contracts";

type NodeStatus = {
  nodeId: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
};

/**
 * The run statuses that stop a run from outside its nodes, leaving any node it
 * had not finished open. A run ends `failed` from outside its nodes when its
 * own retries run out, and `canceled` or `superseded` when a policy ends it.
 */
const STOPPED_RUN_STATUSES: ReadonlySet<WorkflowExecutionStatus> = new Set([
  "canceled",
  "superseded",
  "failed",
]);

/** This module's logger, as the Effect that produces it (see `services/workflows/workflow.ts`). */
const loggerFor = (executionId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("execution-status").with({ executionId })
  );

export const getExecutionStatus = Effect.fn("getExecutionStatus")(
  function* (executionId: string) {
    const repo = yield* ExecutionRepo;
    const logger = yield* loggerFor(executionId);

    const execution = yield* repo.findStatusById(executionId);

    if (!execution) {
      yield* logger.warn("Execution not found for status");
      return yield* new NotFound({ error: "Execution not found" });
    }

    const [logs, openWaitNodeIds, retryingNodeIds] = yield* Effect.all(
      [
        repo.listNodeStatuses(executionId),
        repo.listOpenWaitNodeIds(executionId),
        heldByExecutor(execution.status)
          ? repo.listFailingNodeIds(executionId)
          : Effect.succeed([]),
      ],
      { concurrency: 3 }
    );

    // A run that stopped leaves its unfinished nodes recorded as pending or
    // running, because nothing writes to them once the run stops. The editor
    // draws them as cancelled, so that is what it is told. A node's status is
    // its own vocabulary, which is why the one-L run status maps onto the
    // two-L node one here.
    const nodeStatuses: NodeStatus[] = logs.map((log) => ({
      nodeId: log.nodeId,
      status:
        STOPPED_RUN_STATUSES.has(execution.status) &&
        (log.status === "pending" || log.status === "running")
          ? "cancelled"
          : log.status,
    }));

    return {
      status: execution.status,
      nodeStatuses,
      openWaitNodeIds,
      retryingNodeIds,
    };
  },
  (effect, executionId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(executionId),
          "Failed to get execution status"
        )
      )
    )
);
