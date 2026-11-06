import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import {
  redactSensitiveData,
  redactSensitiveText,
} from "#src/backend/lib/utils/redact";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { STEP_RETRY_LIMIT } from "#src/backend/services/executions/repo/release-policy";
import {
  executorReading,
  heldByExecutor,
  toExecutorStateView,
} from "#src/backend/services/executions/executor-state";

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

/** This module's logger, as the Effect that produces it (see `services/workflows/workflow.ts`). */
const loggerFor = (executionId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("execution-logs").with({ executionId })
  );

export const getExecutionLogs = Effect.fn("getExecutionLogs")(
  function* (executionId: string) {
    const repo = yield* ExecutionRepo;
    const logger = yield* loggerFor(executionId);

    const execution = yield* repo.findSummaryById(executionId);

    if (!execution) {
      yield* logger.warn("Execution not found for logs");
      return yield* new NotFound({ error: "Execution not found" });
    }

    const [logs, waits, termination, executorState] = yield* Effect.all(
      [
        repo.listLogs(executionId),
        repo.listWaitingStates(executionId),
        execution.status === "exited"
          ? repo.findTerminationState(executionId)
          : Effect.succeed(null),
        heldByExecutor(execution.status)
          ? repo.findExecutorState(executionId)
          : Effect.succeed(null),
      ],
      { concurrency: 4 }
    );
    const exitClaim =
      termination?.claim?.kind === "exit" ? termination.claim : null;
    const exit =
      exitClaim && execution.entityType
        ? {
            reason: exitClaim.reason,
            entityType: execution.entityType,
            nodeId: exitClaim.nodeId,
            checkedAt: exitClaim.requestedAt.toISOString(),
          }
        : null;
    const { now, reading } = yield* executorReading;

    return {
      execution: {
        id: execution.id,
        workflowId: execution.workflowId,
        workflowVersionId: execution.workflowVersionId,
        versionKind: execution.versionKind,
        versionNumber: execution.versionNumber,
        status: execution.status,
        startSource: execution.startSource,
        runMode: execution.runMode,
        startEventName: execution.startEventName,
        entityValue: execution.entityValue,
        input: redactSensitiveData(execution.input),
        output: redactSensitiveData(execution.output),
        error: redactSensitiveText(execution.error),
        startedAt: execution.startedAt.toISOString(),
        completedAt: toIso(execution.completedAt),
        duration: execution.duration,
      },
      // Whatever a run or node was handed and answered with passes through the
      // same redaction policy on the way out.
      logs: logs.map((log) => ({
        id: log.id,
        executionId: log.executionId,
        nodeId: log.nodeId,
        nodeName: log.nodeName,
        nodeType: log.nodeType,
        status: log.status,
        input: redactSensitiveData(log.input),
        output: redactSensitiveData(log.output),
        error: redactSensitiveText(log.error),
        startedAt: log.startedAt.toISOString(),
        completedAt: toIso(log.completedAt),
        duration: log.duration,
        retries: log.retries,
      })),
      retryLimit: STEP_RETRY_LIMIT,
      waits: waits.map((wait) => ({
        id: wait.id,
        nodeId: wait.nodeId,
        nodeName: wait.nodeName,
        resumeToken: wait.resumeToken,
        subscribedEvents: wait.subscribedEvents ?? [],
        waitUntil: toIso(wait.waitUntil),
      })),
      exit,
      schedule:
        executorState === null
          ? null
          : toExecutorStateView({ state: executorState, now, reading }),
    };
  },
  (effect, executionId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(executionId),
          "Failed to get execution logs"
        )
      )
    )
);
