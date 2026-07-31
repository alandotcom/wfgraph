import {
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type {
  RunScopedAuditEventType,
  WorkflowScopedAuditEventType,
} from "#src/backend/services/executions/workflow-audit";
import type { JsonObject, JsonObjectDraft } from "@rova/shared/types/json";

/** One row of `workflow_executions`, as the run panel and the engine see it. */
export type WorkflowExecution = typeof workflowExecutions.$inferSelect;

/** One row of `workflow_execution_logs`, one node's attempt within a run. */
export type WorkflowExecutionLog = typeof workflowExecutionLogs.$inferSelect;

/** One row of `workflow_execution_events`, the audit trail beside a run. */
export type WorkflowExecutionEvent =
  typeof workflowExecutionEvents.$inferSelect;

/** One row of `workflow_wait_states`, a node parked waiting to be woken. */
export type WorkflowWaitState = typeof workflowWaitStates.$inferSelect;

/**
 * The columns every entrypoint fills when it opens a run.
 *
 * Status is not among them: which status a new row gets follows from which
 * method is called, so `startForEntity` writes "running" itself rather than
 * trusting a caller to pass it.
 */
export type NewExecution = {
  workflowId: string;
  startSource: NonNullable<WorkflowExecution["startSource"]>;
  runMode: WorkflowExecution["runMode"];
  startEventName?: string;
  entityValue?: string;
  input: JsonObject;
  /**
   * The arrival this run answers, which is what makes opening it idempotent. A
   * start with none is one no retry loop replays, and gets a fresh row every
   * time it is asked for.
   */
  deliveryId?: string;
};

/**
 * A run that reached its verdict without executing the graph. It starts and
 * completes at the same instant, which is what keeps it visible in the runs
 * list beside runs that did execute.
 *
 * Its status is the caller's to choose, from the three a run can be in when it
 * never executed.
 */
export type NewTerminalExecution = NewExecution & {
  status: Extract<
    WorkflowExecution["status"],
    "completed" | "failed" | "canceled"
  >;
  output?: JsonObject;
  error?: string;
};

/** A run without the columns that say how it was triggered. */
export type ExecutionSummary = Pick<
  WorkflowExecution,
  | "id"
  | "workflowId"
  | "status"
  | "input"
  | "output"
  | "error"
  | "startedAt"
  | "completedAt"
  | "duration"
>;

/** A run reduced to where it got to. */
export type ExecutionStatusRow = Pick<WorkflowExecution, "id" | "status">;

/**
 * An execution carrying the two columns of its workflow the cross-workflow runs
 * list shows beside it, which is what the join in `listPage` is for.
 *
 * The canceling Event's payload is left out: it is arbitrary host JSON, and no
 * runs-list row shows it. The engine reads it through `findPendingCancel`.
 */
export type GlobalExecutionRow = Omit<WorkflowExecution, "cancelPayload"> & {
  workflowName: string;
  workflowIsPaused: boolean;
};

/**
 * What Concurrency did when a start asked for room, and the row it opened.
 *
 * `refused` names the runs it deferred to, so first-wins can say what it deferred
 * to rather than only that it declined.
 */
export type EntityStartOutcome =
  | {
      status: "started";
      execution: WorkflowExecution;
      /** Runs this start displaced, already `superseded` in the same transaction. */
      supersededExecutionIds: string[];
      /**
       * Runs this start found stuck between their row and the bus, already
       * `failed` in the same transaction. The caller still signals each one, since
       * a stamped `enqueued_at` that never landed would otherwise leave a live run
       * against a failed row.
       */
      reclaimedExecutionIds: string[];
    }
  | { status: "refused"; inFlightExecutionIds: string[] };

/**
 * A Cancel Event's request, as the run reads it back at its next node boundary.
 *
 * The columns are the whole of the authority: nothing kills the run, so this is
 * how it learns to route to its Canceled outlet (ADR-0007).
 */
export type PendingCancel = {
  eventName: string | null;
  payload: JsonObject | null;
};

/**
 * One audit row.
 *
 * The two arms are what keep the scope honest: a run-scoped type has to name its
 * Execution, and a workflow-scoped one has none to name. The reader for each is
 * keyed on that -- the run timeline by execution id, the Refused Starts panel by
 * the workflow-scoped list -- so a row written into the wrong arm would be a row
 * nothing shows.
 */
export type NewAuditEvent = {
  workflowId: string;
  message: string;
  metadata?: JsonObjectDraft;
} & (
  | { eventType: RunScopedAuditEventType; executionId: string }
  | { eventType: WorkflowScopedAuditEventType; executionId?: undefined }
);

/** What a wait row can move to once it has stopped waiting. */
export type SettledWaitStatus = "resumed" | "timed_out" | "cancelled";

/** Where a page of the cross-workflow runs list resumes from. */
export type ExecutionCursor = {
  startedAt: Date;
  id: string;
};

/** How the runs list narrows what it asks for. */
export type ExecutionPageQuery = {
  workflowIds?: string[];
  statuses?: WorkflowExecution["status"][];
  cursor?: ExecutionCursor;
  limit: number;
};
