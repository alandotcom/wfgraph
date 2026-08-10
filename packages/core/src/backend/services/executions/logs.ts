import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import {
  redactSensitiveData,
  redactSensitiveText,
} from "#src/backend/lib/utils/redact";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

/** This module's logger, as the Effect that produces it (see `services/workflows/workflow.ts`). */
const loggerFor = (executionId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "execution-logs").with({ executionId })
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

    const logs = yield* repo.listLogs(executionId);
    const waits = yield* repo.listWaitingStates(executionId);

    return {
      execution: {
        id: execution.id,
        workflowId: execution.workflowId,
        workflowVersionId: execution.workflowVersionId,
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
      })),
      waits: waits.map((wait) => ({
        id: wait.id,
        nodeId: wait.nodeId,
        nodeName: wait.nodeName,
        resumeToken: wait.resumeToken,
        subscribedEvents: wait.subscribedEvents ?? [],
        waitUntil: toIso(wait.waitUntil),
      })),
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
