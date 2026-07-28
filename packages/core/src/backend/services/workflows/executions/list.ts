import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/database";
import { NotFound } from "#src/backend/lib/effect/failures";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

type WorkflowExecutionItem = {
  id: string;
  workflowId: string;
  status: "pending" | "running" | "waiting" | "success" | "error" | "cancelled";
  triggerType: "manual" | "webhook" | "event" | null;
  runMode: "live" | "test";
  triggerEventType: string | null;
  correlationKey: string | null;
  workflowRunId: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  waitingAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  duration: string | null;
};

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function toWorkflowExecutionItem(input: {
  id: string;
  workflowId: string;
  status: "pending" | "running" | "waiting" | "success" | "error" | "cancelled";
  triggerType: "manual" | "webhook" | "event" | null;
  runMode: "live" | "test";
  triggerEventType: string | null;
  correlationKey: string | null;
  workflowRunId: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: Date;
  waitingAt: Date | null;
  cancelledAt: Date | null;
  completedAt: Date | null;
  duration: string | null;
}): WorkflowExecutionItem {
  return {
    ...input,
    startedAt: input.startedAt.toISOString(),
    waitingAt: toIso(input.waitingAt),
    cancelledAt: toIso(input.cancelledAt),
    completedAt: toIso(input.completedAt),
  };
}

/** What the contract answers a run-history delete with. */
type WorkflowExecutionsDeleted = { success: true; deletedCount: number };

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "executions").with({ workflowId })
  );

export const getWorkflowExecutions = Effect.fn("getWorkflowExecutions")(
  function* (workflowId: string) {
    const workflowRepo = yield* WorkflowRepo;
    const executionRepo = yield* ExecutionRepo;
    const logger = yield* loggerFor(workflowId);

    const workflowExists = yield* workflowRepo.existsById(workflowId);

    if (!workflowExists) {
      yield* logger.warn("Workflow not found for executions list");
      return yield* Effect.fail(new NotFound({ error: "Workflow not found" }));
    }

    const executions = yield* executionRepo.listByWorkflow(workflowId);

    return executions.map(toWorkflowExecutionItem);
  },
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(workflowId),
          "Failed to get workflow executions"
        )
      )
    )
);

export const deleteWorkflowExecutions = Effect.fn("deleteWorkflowExecutions")(
  function* (workflowId: string) {
    const workflowRepo = yield* WorkflowRepo;
    const executionRepo = yield* ExecutionRepo;
    const logger = yield* loggerFor(workflowId);

    const workflowExists = yield* workflowRepo.existsById(workflowId);

    if (!workflowExists) {
      yield* logger.warn("Workflow not found for executions delete");
      return yield* Effect.fail(new NotFound({ error: "Workflow not found" }));
    }

    const deletedCount = yield* executionRepo.deleteAllForWorkflow(workflowId);

    const result: WorkflowExecutionsDeleted = { success: true, deletedCount };
    return result;
  },
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(workflowId),
          "Failed to delete workflow executions"
        )
      )
    )
);
