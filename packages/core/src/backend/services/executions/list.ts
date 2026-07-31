import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import type {
  WorkflowExecutionStartSource,
  WorkflowExecutionStatus,
} from "@rova/shared/lifecycle/execution-contracts";

type WorkflowExecutionItem = {
  id: string;
  workflowId: string;
  status: WorkflowExecutionStatus;
  startSource: WorkflowExecutionStartSource | null;
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
  status: WorkflowExecutionStatus;
  startSource: WorkflowExecutionStartSource | null;
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

/** One Refused Start as the wire carries it. */
function toRefusedStartItem(event: {
  id: string;
  message: string;
  createdAt: Date;
}) {
  return {
    id: event.id,
    message: event.message,
    createdAt: event.createdAt.toISOString(),
  };
}

/** What the contract answers a run-history delete with. */
type WorkflowExecutionsDeleted = { success: true; deletedCount: number };

/** This module's logger, as the Effect that produces it (see `services/workflows/workflow.ts`). */
const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "executions").with({ workflowId })
  );

/**
 * Everything the editor's runs panel reads, in one answer.
 *
 * The runs, how many superseded ones were left out, and the Refused Starts that
 * opened no run at all. One payload rather than three procedures because the panel
 * polls every two seconds: a separate refusals read would double that traffic for
 * a list that is empty on most workflows.
 *
 * `supersededCount` is counted whether or not the rows are asked for, because a
 * builder deciding whether to look needs the number first.
 */
export const getWorkflowExecutions = Effect.fn("getWorkflowExecutions")(
  function* (input: { workflowId: string; includeSuperseded: boolean }) {
    const { workflowId } = input;
    const workflowRepo = yield* WorkflowRepo;
    const executionRepo = yield* ExecutionRepo;
    const logger = yield* loggerFor(workflowId);

    const workflowExists = yield* workflowRepo.existsById(workflowId);

    if (!workflowExists) {
      yield* logger.warn("Workflow not found for executions list");
      return yield* Effect.fail(new NotFound({ error: "Workflow not found" }));
    }

    const [executions, supersededCount, refusedStarts] = yield* Effect.all(
      [
        executionRepo.listByWorkflow({
          workflowId,
          includeSuperseded: input.includeSuperseded,
        }),
        executionRepo.countSuperseded(workflowId),
        executionRepo.listWorkflowEvents(workflowId),
      ],
      { concurrency: 3 }
    );

    return {
      items: executions.map(toWorkflowExecutionItem),
      supersededCount,
      refusedStarts: refusedStarts.map(toRefusedStartItem),
    };
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(input.workflowId),
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
