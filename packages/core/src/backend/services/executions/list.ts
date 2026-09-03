import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import { redactSensitiveText } from "#src/backend/lib/utils/redact";
import {
  ExecutionRepo,
  type WorkflowExecutionListRow,
} from "#src/backend/services/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import type {
  WorkflowExecutionStartSource,
  WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type { WorkflowVersionKind } from "@wfgraph/shared/graph/version-kinds";

type WorkflowExecutionItem = {
  id: string;
  workflowId: string;
  status: WorkflowExecutionStatus;
  startSource: WorkflowExecutionStartSource | null;
  runMode: "live" | "test";
  startEventName: string | null;
  entityValue: string | null;
  workflowRunId: string | null;
  versionKind: WorkflowVersionKind;
  versionNumber: number | null;
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

function toWorkflowExecutionItem(
  row: WorkflowExecutionListRow
): WorkflowExecutionItem {
  return {
    id: row.id,
    workflowId: row.workflowId,
    status: row.status,
    startSource: row.startSource,
    runMode: row.runMode,
    startEventName: row.startEventName,
    entityValue: row.entityValue,
    workflowRunId: row.workflowRunId,
    versionKind: row.versionKind,
    versionNumber: row.versionNumber,
    error: redactSensitiveText(row.error),
    startedAt: row.startedAt.toISOString(),
    waitingAt: toIso(row.waitingAt),
    cancelledAt: toIso(row.cancelledAt),
    completedAt: toIso(row.completedAt),
    duration: row.duration,
  };
}

/** One workflow-level audit row as the wire carries it. */
function toWorkflowAuditItem(event: {
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
    appLogger.get("executions").with({ workflowId })
  );

/**
 * Everything the editor's runs panel reads, in one answer.
 *
 * The runs, how many superseded ones were left out, and workflow-level audit
 * rows that opened no run. The response separates Refused Starts from
 * Cancellation Failures. One payload rather than three procedures avoids extra
 * traffic while the panel polls every two seconds.
 *
 * Start and result payloads stay off the rows: the panel never paints them, and
 * a poll that retransmitted JSONB for fifty runs would be the same shape of
 * waste `getVersionGraph` already moved off the logs payload. They ride
 * `getExecutionLogs` for the one open run.
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
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const [executions, supersededCount, refusedStarts, cancelNotDelivered] =
      yield* Effect.all(
        [
          executionRepo.listByWorkflow({
            workflowId,
            includeSuperseded: input.includeSuperseded,
          }),
          executionRepo.countSuperseded(workflowId),
          executionRepo.listWorkflowEvents({
            workflowId,
            eventType: "run_refused",
          }),
          executionRepo.listWorkflowEvents({
            workflowId,
            eventType: "cancel_not_delivered",
          }),
        ],
        { concurrency: 4 }
      );

    return {
      items: executions.map(toWorkflowExecutionItem),
      supersededCount,
      refusedStarts: refusedStarts.map(toWorkflowAuditItem),
      cancelNotDelivered: cancelNotDelivered.map(toWorkflowAuditItem),
    };
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
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
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const deletedCount = yield* executionRepo.deleteAllForWorkflow(workflowId);

    const result: WorkflowExecutionsDeleted = { success: true, deletedCount };
    return result;
  },
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(workflowId),
          "Failed to delete workflow executions"
        )
      )
    )
);
