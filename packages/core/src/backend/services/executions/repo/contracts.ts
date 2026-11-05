import type { Effect } from "effect";
import {
  type ExecutionScheduleKind,
  type ExecutionScheduleState,
  type ParkWake,
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import type { Conflict } from "#src/backend/lib/effect/failures";
import type {
  RunScopedAuditEventType,
  WorkflowScopedAuditEventType,
} from "@wfgraph/shared/lifecycle/audit-event-types";
import type {
  EntityEligibilityReason,
  WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
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
} from "#src/backend/lib/db/schema";

/**
 * The pass a write is made for: the Execution it runs and the fencing token its
 * claim minted. A write carrying a fence commits only while the Execution's
 * schedule row is still `leased` under that token.
 */
export type OwnerFence = {
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

/**
 * The fenced twin of a `StoreWrite`. It takes the Execution's schedule row
 * inside its own transaction before anything else, and answers `Conflict`
 * without writing when that row no longer names the pass.
 */
export type FencedWrite<Write> =
  Write extends StoreWrite<infer Input, infer Output>
    ? (input: Input) => Effect.Effect<Output, DatabaseError | Conflict>
    : never;

/** One row of `workflow_execution_schedule`, as the executor reads it. */
export type ExecutionSchedule = {
  executionId: string;
  kind: ExecutionScheduleKind;
  state: ExecutionScheduleState;
  wakeAt: Date;
  attempt: number;
  leaseExpiresAt: Date | null;
  ownerToken: string | null;
  workerId: string | null;
  lastError: string | null;
};

/** A schedule row a claim leased to one worker's pass. */
export type ClaimedExecution = {
  executionId: string;
  kind: ExecutionScheduleKind;
  /** The fencing token every write of this pass carries. */
  ownerToken: string;
  /**
   * The retry counter after the claim. It is one higher than before only when
   * the claim swept an expired lease.
   */
  attempt: number;
  leaseExpiresAt: Date;
};

/**
 * How a pass that wrote no terminal record ended, which decides the schedule
 * row its release writes.
 *
 * - `parked`: the body ended with work parked. The release re-queues the run
 *   when a park holds a wake the pass did not consume, and otherwise puts it to
 *   sleep until its earliest park deadline.
 * - `retry`: a step threw a retriable error. The release counts an attempt and
 *   re-queues the run after `backoffMs`.
 * - `retries_spent`: a step's retries ran out. The release records `failure`
 *   as that step's memoized result, resets the attempt counter, and re-queues
 *   the run, so the step fails its node and the rest of the run goes on.
 * - `fence_refused`: a version fence refused a write because a Migration moved
 *   the run. Nothing failed, so the release re-queues the run without counting
 *   an attempt, and the next pass loads the version the run now pins.
 */
export type PassOutcome =
  | { kind: "parked" }
  | { kind: "retry"; error: string; backoffMs: number }
  | { kind: "retries_spent"; stepId: string; failure: JsonValue }
  | { kind: "fence_refused" };

/** The schedule row a release left behind. */
export type ReleasedSchedule = {
  state: Extract<ExecutionScheduleState, "queued" | "waiting">;
  wakeAt: Date;
  attempt: number;
};

/** One memoized step of an Execution. */
export type StepMemoEntry = {
  stepId: string;
  /** The schedule row's attempt counter when the step's value was recorded. */
  attempt: number;
  value: JsonValue;
};

/** What a producer's write did to a park and to its run's schedule row. */
export type ParkResolution = {
  /** Whether this call set the wake. False when the row had left `waiting`. */
  resolved: boolean;
  /** Whether this call moved a `waiting` schedule row to `queued`. */
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
