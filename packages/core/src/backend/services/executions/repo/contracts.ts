import type { Effect } from "effect";
import {
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import type {
  RunScopedAuditEventType,
  WorkflowScopedAuditEventType,
} from "@wfgraph/shared/lifecycle/audit-event-types";
import type {
  EntityEligibilityReason,
  WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type {
  ExecutionScheduleKind,
  ExecutionScheduleState,
  ParkWake,
} from "@wfgraph/shared/lifecycle/execution-schedule";
import type {
  JsonObject,
  JsonObjectDraft,
  JsonValue,
} from "@wfgraph/shared/types/json";
import type { WorkflowVersionKind } from "@wfgraph/shared/graph/version-kinds";

export type {
  ExecutionScheduleKind,
  ExecutionScheduleState,
  ParkWake,
} from "@wfgraph/shared/lifecycle/execution-schedule";

/**
 * The pass a write is made for: the schedule row its claim leased, the
 * fencing token that claim minted, and the Execution the row runs. A write
 * carrying a fence commits only while that schedule row is still `leased`
 * under that token and still names that Execution, and a fenced write that
 * addresses another Execution is refused.
 */
export type OwnerFence = {
  scheduleId: string;
  executionId: string;
  ownerToken: string;
};

/**
 * A write the engine's store makes, as the Inngest path calls it: unfenced, so
 * it is never refused for ownership. `ExecutionRepo.fenced` offers the same
 * write fenced on a pass.
 */
export type StoreWrite<Input, Output> = (
  input: Input
) => Effect.Effect<Output, DatabaseError>;

/** One row of `workflow_execution_schedule`, as the executor reads it. */
export type ExecutionSchedule = {
  id: string;
  kind: ExecutionScheduleKind;
  /** The run the row schedules, and null on a `delivery` row. */
  executionId: string | null;
  state: ExecutionScheduleState;
  wakeAt: Date;
  /** The run's own failure count. See `workflow_execution_schedule.attempt`. */
  attempt: number;
  /** The step the leased pass last recorded as running, or null. */
  runningStepId: string | null;
  leaseExpiresAt: Date | null;
  ownerToken: string | null;
  workerId: string | null;
  lastError: string | null;
};

/** A run's schedule row a claim leased to one worker's pass. */
export type ClaimedExecution = {
  scheduleId: string;
  executionId: string;
  /** The fencing token every write of this pass carries. */
  ownerToken: string;
  /**
   * The run's own failure count after the claim. It is one higher than before
   * only when the claim swept a lease that expired with no step recorded as
   * running. A count past `STEP_RETRY_LIMIT` ends the run failed.
   */
  attempt: number;
  leaseExpiresAt: Date;
};

/**
 * How a pass that wrote no terminal record ended, which decides the schedule
 * row and the memo row its release writes. Every outcome but `run_failed`
 * resets the run's own failure count.
 *
 * - `parked`: the body ended with work parked. The release re-queues the run
 *   when a park holds a wake the pass did not consume, and otherwise puts it to
 *   sleep until its earliest park deadline.
 * - `step_failed`: the step `stepId` threw a retriable error. The release
 *   counts one failure on that step's memo row. A step still within its
 *   retries is re-queued after `backoffMs`; a step whose count passed the
 *   limit becomes `failed` and the run is re-queued at once, so the step fails
 *   its node and the rest of the run goes on.
 * - `run_failed`: the body failed outside any step. The release counts one
 *   failure against the run's own count and re-queues the run after
 *   `backoffMs`.
 * - `fence_refused`: a version fence refused a write because a Migration moved
 *   the run. Nothing failed, so the release re-queues the run at once and
 *   counts nothing, and the next pass loads the version the run now pins.
 */
export type PassOutcome =
  | { kind: "parked" }
  | { kind: "step_failed"; stepId: string; error: string; backoffMs: number }
  | { kind: "run_failed"; error: string; backoffMs: number }
  | { kind: "fence_refused" };

/** The schedule row a release left behind. */
export type ReleasedSchedule = {
  state: Extract<ExecutionScheduleState, "queued" | "waiting">;
  wakeAt: Date;
  attempt: number;
};

/**
 * One durable step's memo row, by its status. `failures` is the count of
 * retriable failures the step has had, which a `succeeded` row keeps.
 */
export type StepMemo =
  | { status: "succeeded"; failures: number; value: JsonValue }
  | { status: "failing"; failures: number; error: string }
  | { status: "failed"; failures: number; error: string };

/** A memo row a failure was just counted on. */
export type CountedStepFailure = Extract<
  StepMemo,
  { status: "failing" | "failed" }
>;

/** One memo row of a schedule row's body. */
export type StepMemoEntry = StepMemo & { stepId: string };

/** What a release wrote. */
export type ReleasedPass = {
  schedule: ReleasedSchedule;
  /**
   * The memo row of the step a `step_failed` outcome named, after the release
   * counted the failure on it, and null for every other outcome.
   */
  countedStep: CountedStepFailure | null;
};

/** What a producer's write did to a park and to its run's schedule row. */
export type ParkResolution = {
  /** Whether this call set the wake. False when the row had left `waiting`. */
  resolved: boolean;
  /**
   * Whether this call moved a `waiting` schedule row to `queued`. Only a wake
   * this call set re-queues the run.
   */
  requeued: boolean;
};

/** One row of `workflow_executions`, as the Runs view and the engine see it. */
export type WorkflowExecution = typeof workflowExecutions.$inferSelect;

/**
 * One row of `workflow_execution_logs`, one node's attempt within a run.
 *
 * `released_outlet` is left out: no write fills it yet, and no reader asks.
 */
export type WorkflowExecutionLog = Omit<
  typeof workflowExecutionLogs.$inferSelect,
  "releasedOutlet"
>;

/**
 * One row of `workflow_execution_events`, the audit trail beside a run.
 *
 * `seq` is absent: it is the PostgreSQL identity column the audit readers order
 * on after `created_at`, the SQLite table has no counterpart for it, and no
 * caller reads it.
 */
export type WorkflowExecutionEvent = Omit<
  typeof workflowExecutionEvents.$inferSelect,
  "seq"
>;

/**
 * One row of `workflow_wait_states`, a node parked waiting to be woken.
 *
 * The database executor's two columns, `park_step_id` and `wake`, are left
 * out: they are read through `findPark`, which is the one reader that needs
 * them.
 */
export type WorkflowWaitState = Omit<
  typeof workflowWaitStates.$inferSelect,
  "parkStepId" | "wake"
>;

/** A park as the database executor reads it back. */
export type ParkState = {
  waitStateId: string;
  executionId: string;
  status: WorkflowWaitState["status"];
  /** The durable step that parked on this row, or null before one recorded it. */
  parkStepId: string | null;
  /** How the park was resolved, or null while it is still parked. */
  wake: ParkWake | null;
};

/**
 * The columns every entrypoint fills when it opens a run.
 *
 * Status is not among them: which status a new row gets follows from which
 * method is called, so `startForEntity` writes "running" itself rather than
 * trusting a caller to pass it.
 */
export type NewExecution = {
  workflowId: string;
  /**
   * The version this run pins, published or a draft snapshot. Required even when
   * the row is terminal and never executes: the Runs view still resolves node
   * ids against it.
   */
  workflowVersionId: string;
  startSource: NonNullable<WorkflowExecution["startSource"]>;
  runMode: WorkflowExecution["runMode"];
  startEventName?: string | undefined;
  entityValue?: string | undefined;
  input: JsonObject;
  /**
   * The arrival this run answers, which is what makes opening it idempotent. A
   * start with none is one no retry loop replays, and gets a fresh row every
   * time it is asked for.
   */
  deliveryId?: string | undefined;
} & (
  | {
      /** Stable typed identity for a workflow guarded by Entity Eligibility. */
      entityType: string;
      entityId: string;
    }
  | {
      entityType?: never;
      entityId?: never;
    }
);

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
  output?: JsonObject | undefined;
  error?: string | undefined;
};

/**
 * The logs payload's run row: where it got to, plus the fields that distinguish
 * how it was started (mode, source, event, entity). Omits the rest of the
 * routing columns the panel does not paint from this thinner shape.
 */
export type ExecutionSummary = Pick<
  WorkflowExecution,
  | "id"
  | "workflowId"
  | "workflowVersionId"
  | "status"
  | "startSource"
  | "runMode"
  | "startEventName"
  | "entityValue"
  | "input"
  | "output"
  | "error"
  | "startedAt"
  | "completedAt"
  | "duration"
> & {
  /**
   * What sort of version the run pinned, joined from `workflow_versions`. The
   * panel uses it to tell a run of the published graph from a run of the canvas,
   * which pins a snapshot of its own.
   */
  versionKind: WorkflowVersionKind;
  /**
   * That version's number, joined beside the kind. The panel uses it to name the
   * published graph a run walked ("v7"). Null on a draft snapshot.
   */
  versionNumber: number | null;
  /**
   * The typed Entity identity a guarded run was started for, or null on a
   * run with no tracked Entity.
   */
  entityType: string | null;
  entityId: string | null;
};

/**
 * One in-flight run in the columns a Migration decides from: where the run got
 * to, which version it pinned, and how that version is identified.
 *
 * A Migration classifies every in-flight run of a workflow at once, so this
 * shape is deliberately thinner than `ExecutionSummary`: the start and result
 * payloads are JSONB the verdict never reads.
 */
export type InFlightExecutionRow = Pick<
  WorkflowExecution,
  "id" | "status" | "workflowVersionId"
> & {
  /** As on `ExecutionSummary`: which sort of version this run pinned. */
  versionKind: WorkflowVersionKind;
  /** As on `ExecutionSummary`: that version's number, null on a snapshot. */
  versionNumber: number | null;
  /** As on `ExecutionSummary`: the typed Entity identity, null when unguarded. */
  entityType: string | null;
  entityId: string | null;
};

/** A run reduced to where it got to. */
export type ExecutionStatusRow = Pick<WorkflowExecution, "id" | "status">;

/**
 * A run as the two list queries return it: identity, status, timing, and how
 * it was started. Start and result payloads, the cancel Event's payload, and
 * the routing columns the lists never paint stay off this shape so a two-second
 * poll does not read JSONB the panel discards.
 */
export type WorkflowExecutionListRow = Pick<
  WorkflowExecution,
  | "id"
  | "workflowId"
  | "status"
  | "startSource"
  | "runMode"
  | "startEventName"
  | "entityValue"
  | "workflowRunId"
  | "error"
  | "startedAt"
  | "waitingAt"
  | "cancelledAt"
  | "completedAt"
  | "duration"
> & {
  /** As on `ExecutionSummary`: which sort of version this run pinned. */
  versionKind: WorkflowVersionKind;
  /** As on `ExecutionSummary`: that version's number, null on a snapshot. */
  versionNumber: number | null;
};

/**
 * An execution carrying the two columns of its workflow the cross-workflow runs
 * list shows beside it, which is what the join in `listPage` is for.
 *
 * The canceling Event's payload is left out: it is arbitrary host JSON, and no
 * runs-list row shows it. The engine reads it through `findPendingCancel`.
 */
export type GlobalExecutionRow = WorkflowExecutionListRow & {
  workflowName: string;
  workflowIsPaused: boolean;
};

/**
 * What Concurrency did when a start asked for room, and the row it opened.
 *
 * `refused` names the runs it deferred to, so first-wins can say what it deferred
 * to rather than only that it declined.
 */
export type StartAdmissionDecision =
  | { kind: "started"; executionId: string }
  | { kind: "refused"; reason: EntityEligibilityReason };

export type EntityStartOutcome =
  | {
      status: "started";
      execution: WorkflowExecution;
      /** Runs this start displaced, already `superseded` in the same transaction. */
      supersededExecutionIds: string[];
      /**
       * Runs this start found stuck between their row and the bus, already
       * `failed` in the same transaction. The caller still signals each one,
       * because a stamped `enqueued_at` that never landed would otherwise leave
       * a live run against a failed row.
       */
      reclaimedExecutionIds: string[];
    }
  | { status: "refused"; inFlightExecutionIds: string[] }
  | {
      /** An earlier or racing admission refusal owns this delivery. */
      status: "admission_refused";
      reason: EntityEligibilityReason;
    };

export type ExecutionTerminationClaim =
  | {
      kind: "cancel";
      requestedAt: Date;
      eventName: string | null;
      payload: JsonObject | null;
    }
  | {
      kind: "exit";
      requestedAt: Date;
      reason: EntityEligibilityReason;
      nodeId: string;
    };

/**
 * The authoritative execution boundary after a claim or terminal write.
 *
 * A claim may coexist with an in-flight status while the parent run cleans up.
 * A terminal status has no pending claim unless it is the finalized result of
 * that same cancel or exit request.
 */
export type ExecutionTerminationState = {
  executionId: string;
  status: WorkflowExecutionStatus;
  claim: ExecutionTerminationClaim | null;
  /** Whether this call wrote the decision or terminal status it requested. */
  didWrite: boolean;
};

/** The typed Entity identity, or the legacy untyped correlation value. */
export type ExecutionEntitySelector =
  | {
      entityType: string;
      entityId: string;
      entityValue?: never;
    }
  | {
      entityType?: never;
      entityId?: never;
      entityValue: string;
    };

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
 * Execution, and a workflow-scoped one has none to name. The run timeline reads
 * run-scoped rows by execution id. The Refused Starts and Cancellation Failures
 * readers query workflow-scoped rows by workflow id and event type. A row
 * written into the wrong arm would be unreadable.
 */
export type NewAuditEvent = {
  workflowId: string;
  message: string;
  metadata?: JsonObjectDraft | undefined;
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
  workflowIds?: string[] | undefined;
  statuses?: WorkflowExecution["status"][] | undefined;
  cursor?: ExecutionCursor | undefined;
  limit: number;
};
