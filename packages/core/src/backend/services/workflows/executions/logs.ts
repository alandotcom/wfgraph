import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/database";
import { NotFound } from "#src/backend/lib/effect/failures";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo";

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
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
      return yield* Effect.fail(new NotFound({ error: "Execution not found" }));
    }

    const logs = yield* repo.listLogs(executionId);

    return {
      execution: {
        id: execution.id,
        workflowId: execution.workflowId,
        status: execution.status,
        input: execution.input,
        output: execution.output,
        error: execution.error,
        startedAt: execution.startedAt.toISOString(),
        completedAt: toIso(execution.completedAt),
        duration: execution.duration,
      },
      // Whatever a node was handed and answered with is shown here verbatim,
      // which is why it passes through redaction on the way out.
      logs: logs.map((log) => ({
        id: log.id,
        executionId: log.executionId,
        nodeId: log.nodeId,
        nodeName: log.nodeName,
        nodeType: log.nodeType,
        status: log.status,
        input: redactSensitiveData(log.input),
        output: redactSensitiveData(log.output),
        error: log.error,
        startedAt: log.startedAt.toISOString(),
        completedAt: toIso(log.completedAt),
        duration: log.duration,
      })),
    };
  },
  (effect, executionId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(executionId),
          "Failed to get execution logs"
        )
      )
    )
);
