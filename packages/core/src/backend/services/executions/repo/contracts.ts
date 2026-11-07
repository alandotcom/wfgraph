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
import type { WorkflowMode } from "@wfgraph/shared/graph/types";
import type { Concurrency } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { CronSchedule } from "@wfgraph/shared/lifecycle/cron-schedule";

export type {
  ExecutionScheduleKind,
  ExecutionScheduleState,
  ParkWake,
} from "@wfgraph/shared/lifecycle/execution-schedule";

/**
 * The pass a write is made for: the schedule row its claim leased and the
 * fencing token that claim minted. A write carrying a fence commits only while
 * that schedule row is still `leased` under that token.
 */
export type OwnerFence = {
  scheduleId: string;
  ownerToken: string;
};

/**
 * The fence of a pass over a `run` row, with the Execution the row runs. The
 * engine's store writes carry it: each also checks that its schedule row still
 * names that Execution, and a write that addresses another Execution is
 * refused.
 */
export type RunFence = OwnerFence & { executionId: string };

/**
 * The fence of a pass over a `delivery` row, with the inbox row the row
 * delivers. A write carrying it also checks that its schedule row still names
 * that inbox row.
 */
export type DeliveryFence = OwnerFence & { inboxId: string };

/**
 * The fence of a pass over a `cron` row, with the workflow whose schedule the
 * row times. A write carrying it also checks that its schedule row still names
 * that workflow.
 */
export type CronFence = OwnerFence & { workflowId: string };

/**
 * The fence of a pass over a schedule row of any kind. A `RunFence` names the
 * Execution the row runs, a `DeliveryFence` the inbox row it delivers and a
 * `CronFence` the workflow it times, and a fenced write also checks that its
 * schedule row still names it (`leasedUnderFence` in `release-policy.ts`).
 */
export type PassFence = RunFence | DeliveryFence | CronFence;

/**
 * A write the engine's store makes, unfenced, so it is never refused for
 * ownership: a pass makes it this way once it has written the run's terminal
 * record. `ExecutionRepo.fenced` offers the same write fenced on a pass.
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
  /** The inbox row the row delivers, and null on any other kind. */
  inboxId: string | null;
  /** The workflow a `cron` row's schedule belongs to, and null on any other kind. */
  workflowId: string | null;
  /** A `cron` row's schedule expression, and null on any other kind. */
  cron: string | null;
  /** A `cron` row's schedule time zone, and null on any other kind. */
  timeZone: string | null;
  state: ExecutionScheduleState;
  wakeAt: Date;
  /** The run's own failure count. See `workflow_execution_schedule.attempt`. */
  attempt: number;
  /** The step the leased pass last recorded as running, or null. */
  runningStepId: string | null;
  /** The node `runningStepId` does work for, or null for a step of no node. */
  runningNodeId: string | null;
  leaseExpiresAt: Date | null;
  ownerToken: string | null;
  workerId: string | null;
  lastError: string | null;
};

/**
 * How a read names one schedule row: by its own id, for a `run` row by the
 * Execution it runs, or for a `delivery` row by the inbox row it delivers. At
 * most one row names each Execution and each inbox row.
 */
export type ScheduleRowKey =
  | { scheduleId: string }
  | { executionId: string }
  | { inboxId: string };

/** What every leased schedule row carries, whatever it runs. */
type ScheduleLease = {
  scheduleId: string;
  /** The fencing token every write of this pass carries. */
  ownerToken: string;
  /**
   * The row's own failure count after the claim. It is one higher than before
   * only when the claim swept a lease that expired with no step recorded as
   * running. A count past `STEP_RETRY_LIMIT` ends the row's subject failed.
   */
  attempt: number;
  leaseExpiresAt: Date;
};

/** A `run` row a claim leased: one workflow run, which names its Execution. */
export type ClaimedRun = ScheduleLease & {
  kind: "run";
  executionId: string;
};

/**
 * A `delivery` row a claim leased: one arrival's delivery, which names its
 * inbox row.
 */
export type ClaimedDelivery = ScheduleLease & {
  kind: "delivery";
  inboxId: string;
};

/**
 * A `cron` row a claim leased: one schedule's timer, which names its workflow
 * and the schedule it fires.
 */
export type ClaimedCron = ScheduleLease & {
  kind: "cron";
  workflowId: string;
  schedule: CronSchedule;
};

/**
 * A schedule row a claim leased to one worker's pass, by what the row runs.
 * `kind` picks the pass's body, and each schedule kind is one member of this
 * union, claimed by a claim lane for that kind.
 */
export type ClaimedSchedule = ClaimedRun | ClaimedDelivery | ClaimedCron;

/**
 * One lane of a claim: up to `limit` due rows of `kind`. A worker claims each
 * kind in a lane of its own, so runs and deliveries never wait for each
 * other's slots.
 */
export type ClaimLane = { kind: ClaimedSchedule["kind"]; limit: number };

/**
 * How a pass that did not end its row's subject ended, which decides the
 * schedule row and the memo row its release writes. `body_failed` counts one
 * failure against the row's own failure count, `interrupted` leaves that count
 * as it was, and every other outcome resets it.
 *
 * - `parked`: the body ended with work parked. The release re-queues the run
 *   when a park holds a wake the pass did not consume, and otherwise puts it to
 *   sleep until its earliest park deadline.
 * - `step_failed`: the step `stepId` threw a retriable error. The release
 *   counts one failure on that step's memo row, which carries `nodeId`. A
 *   step still within its retries is re-queued after `backoffMs`; a step whose
 *   count passed the limit becomes `failed` and the run is re-queued at once,
 *   so the step fails its node and the rest of the run goes on.
 * - `body_failed`: the body failed outside any step. The release counts one
 *   failure against the row's own count and re-queues the row after
 *   `backoffMs`.
 * - `fence_refused`: a version fence refused a write because a Migration moved
 *   the run. Nothing failed, so the release re-queues the run at once and
 *   counts nothing, and the next pass loads the version the run now pins.
 * - `interrupted` with `by: "drain"`: a worker stopping gracefully interrupted
 *   the pass, as a dispose does to a pass still running when its drain ends.
 *   Nothing failed, so the release re-queues the row at once and counts
 *   nothing, against the row or against the step that was running.
 * - `interrupted` with `by: "budget"`: the pass was still running when its
 *   host's time budget ran out, as a Worker tick's does. The release re-queues
 *   the row at once and counts one failure on the memo row of `stepId`, the
 *   step the pass was running, which carries `nodeId`, as a claim counts one
 *   against a step whose lease expired under it, so a step that outlasts
 *   every budget spends its retries and fails its node. A pass cut between
 *   steps (`stepId` null) counts nothing.
 */
export type PassOutcome =
  | { kind: "parked" }
  | {
      kind: "step_failed";
      stepId: string;
      nodeId: string | null;
      error: string;
      backoffMs: number;
    }
  | { kind: "body_failed"; error: string; backoffMs: number }
  | { kind: "fence_refused" }
  | { kind: "interrupted"; by: "drain" }
  | {
      kind: "interrupted";
      by: "budget";
      stepId: string | null;
      nodeId: string | null;
    };

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

/**
 * One memo row of a schedule row's body, with the node its step does work
 * for, or null for a step of no node.
 */
export type StepMemoEntry = StepMemo & {
  stepId: string;
  nodeId: string | null;
};

/** What a release wrote. */
export type ReleasedPass = {
  schedule: ReleasedSchedule;
  /**
   * The memo row of the step a `step_failed` outcome named, after the release
   * counted the failure on it, and null for every other outcome.
   */
  countedStep: CountedStepFailure | null;
};

/** A memo row of a step that failed and will run again on a later pass. */
export type FailingStep = {
  stepId: string;
  /** The node the step does work for, or null for a step of no node. */
  nodeId: string | null;
  /**
   * That node's name as its log row records it, and null when the run has no
   * log row for the node yet, as for a step that runs before the node's log
   * opens.
   */
  nodeName: string | null;
  /** The retriable failures counted against the step so far. */
  failures: number;
  /** The step's last failure. */
  error: string;
};

/**
 * A park holding a wake no pass has consumed yet: a wait row `resuming` with
 * a wake. The run's next pass reads the wake and moves the Wait on.
 */
export type UnconsumedWake = {
  waitStateId: string;
  nodeId: string;
  nodeName: string;
  /** Which producer resolved the park. */
  kind: ParkWake["kind"];
  /** The Event a `resume` wake carries, and null for any other wake or a resume naming none. */
  eventName: string | null;
  /** When an Event or a manual resume claimed the park, and null for a wake another producer wrote. */
  wokenAt: Date | null;
  /** The park's deadline, and null for a park with none. */
  deadline: Date | null;
};

/**
 * Where the database executor holds one open run, from its schedule row and
 * its failing steps: what both executor-state reads answer for a run. The
 * schedule row's columns are as `ExecutionSchedule` describes them.
 */
export type ExecutorHold = Pick<
  ExecutionSchedule,
  | "state"
  | "wakeAt"
  | "attempt"
  | "runningStepId"
  | "runningNodeId"
  | "leaseExpiresAt"
  | "workerId"
  | "lastError"
> & {
  /** The name of the node of `runningNodeId`, read as `FailingStep.nodeName` is. */
  runningNodeName: string | null;
  /** Every step of the run that failed and will run again, most failures first. */
  failingSteps: FailingStep[];
};

/**
 * An `ExecutorHold` with the run's wakes, read for a person asking why one
 * run has not moved and when it will move next.
 */
export type ExecutorState = ExecutorHold & {
  /** Every park of the run holding a wake no pass has consumed, oldest first. */
  unconsumedWakes: UnconsumedWake[];
};

/**
 * What the database executor is doing about one open run. Which case holds is
 * decided by `executorActivityOf` (`repo/executor-activity.ts`), whose comment
 * gives the order the cases are tested in. Each case means:
 *
 * - `resuming`: a producer resolved one of the run's parks (`wake` says which
 *   producer) and no pass has read the wake yet. `wokenAt` is when an Event or
 *   a manual resume claimed the park, and `deadline` is the park's own
 *   deadline, which a `timeout` wake passed. `unclaimedSince` is when the wake
 *   began waiting for a worker (`wokenAt`, or the schedule row's wake time for
 *   a wake that records none), and null while a worker holds a live lease on
 *   the run.
 * - `lease_expired`: the worker that leased the run stopped renewing its lease
 *   at `since`, while running a step of `nodeId` (null between steps). The
 *   next claim takes the run over.
 * - `running`: a worker, `workerId`, holds a live lease and is running a step
 *   of `nodeId`, or is between steps when that is null.
 * - `retrying`: the run is queued until `nextTryAt`, after a failure. A step's
 *   failure names the step's node (null for a step of no node), counts the
 *   step's failures and carries its last error; a failure of the run body
 *   outside any step names no node, counts the run's own failures and carries
 *   the schedule row's last error.
 * - `unclaimed`: the run has been due since `dueSince` and no worker has
 *   claimed it.
 * - `waiting`: the run is asleep on its parks and not yet due.
 *
 * A named node's `nodeName` is read as `FailingStep.nodeName` is.
 */
export type ExecutorActivity =
  | {
      kind: "resuming";
      nodeId: string;
      nodeName: string;
      wake: ParkWake["kind"];
      eventName: string | null;
      wokenAt: Date | null;
      deadline: Date | null;
      unclaimedSince: Date | null;
    }
  | {
      kind: "lease_expired";
      nodeId: string | null;
      nodeName: string | null;
      since: Date;
    }
  | {
      kind: "running";
      nodeId: string | null;
      nodeName: string | null;
      workerId: string | null;
    }
  | {
      kind: "retrying";
      nodeId: string | null;
      nodeName: string | null;
      nextTryAt: Date;
      failures: number;
      error: string | null;
    }
  | { kind: "unclaimed"; dueSince: Date }
  | { kind: "waiting" };

/** What a producer's write did to a park and to its run's schedule row. */
export type ParkResolution = {
  /** Whether this call set the wake. False when the row had left `waiting`. */
  resolved: boolean;
  /**
   * Whether this call made the run due: its schedule row is `queued` and due
   * by the write's `now`. Only a wake this call set makes the run due, and a
   * `leased` row is left for its release.
   */
  requeued: boolean;
};

/**
 * A park an Event or a manual resume claimed, with the wake the claim wrote on
 * it. `requeued` says whether the claim made the run due (`wakeExecutions`),
 * which is when the caller wakes a worker loop.
 */
export type WaitResumeClaim = {
  waitState: WorkflowWaitState;
  requeued: boolean;
};

/**
 * A run a Cancel Event's claim answers for, by who claimed it for its Canceled
 * outlet.
 *
 * - `claimed`: this write claimed the run, and `resolvedParks` and `requeued`
 *   say what it did to the run's parks in the same transaction.
 * - `claimed_earlier`: an earlier attempt of the same delivery claimed the run,
 *   and this write changed nothing. A retried delivery still answers it, so
 *   the arrival stays off the Waits of the run it claimed, including a Wait
 *   the run's Canceled outlet parked since.
 */
export type CanceledOutletClaim =
  | {
      kind: "claimed";
      executionId: string;
      /**
       * How many parks the claim resolved with a `cancel` wake. Every park
       * open when the claim landed is on the Started side, since a
       * Canceled-side Wait parks only under a Cancel claim.
       */
      resolvedParks: number;
      /** Whether the claim made the run due, as `ParkResolution.requeued` says. */
      requeued: boolean;
    }
  | { kind: "claimed_earlier"; executionId: string };

/**
 * What a Migration's repin did. A run that moved is made due unless a pass
 * holds it, in which case that pass's release reads the `migrate` wakes.
 */
export type RepinOutcome =
  | { moved: false }
  | { moved: true; requeued: boolean };

/**
 * One row of `workflow_executions`, as the Runs view and the engine see it.
 *
 * `cancel_delivery_id` is left out: only the Cancel producer reads it, inside
 * its own write.
 */
export type WorkflowExecution = Omit<
  typeof workflowExecutions.$inferSelect,
  "cancelDeliveryId"
>;

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
  /**
   * For a scheduled run, the schedule that fired it and the slot it fired
   * for. Absent on every other start.
   */
  scheduled?: { slot: Date; schedule: CronSchedule } | undefined;
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
 * What `ExecutionRepo.startForEntity` is asked to open.
 *
 * The transaction that inserts the execution row also writes the run's
 * schedule row, due at `now`, and its "run started" timeline entry, so an
 * open run always has both. A start answered with a row an earlier attempt of
 * the same delivery committed writes neither again.
 */
export type StartForEntityInput = {
  /**
   * The row to open. Concurrency serializes on its typed Entity identity when
   * present, otherwise on the legacy `entityValue`. A start with neither
   * identity leaves Entity-scoped Concurrency out.
   */
  execution: NewExecution;
  concurrency: Concurrency;
  /** Stable key shared with an admission refusal for this Event delivery. */
  admissionDecisionId?: string | undefined;
  /** Written onto a displaced run's `error`, which run history shows. */
  supersededReason: string;
  /** The run's opening timeline entry, written as a `run_started` row. */
  startedEntry: { message: string; metadata: JsonObject };
  /** When the new run falls due: its schedule row's `wake_at`. */
  now: Date;
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
  | "scheduledFor"
  | "scheduleCron"
  | "scheduleTimeZone"
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
  | "error"
  | "startedAt"
  | "scheduledFor"
  | "scheduleCron"
  | "scheduleTimeZone"
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
 * A claim may coexist with an in-flight status while the run's next pass
 * routes it: a Cancel claim runs the Canceled outlet first, and an Exit claim
 * halts the run's other branches.
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

/**
 * An arrival as a source hands it to the inbox. `name` is a catalog Event
 * name and `data` its payload.
 */
export type NewInboxEvent = {
  name: string;
  data: JsonObject;
  /** The Connection an integration Event arrived through, or null. */
  connectionId: string | null;
  /**
   * The source's own id for the arrival, or null for one with none. A second
   * arrival with the same name, Connection and key is a duplicate while the
   * first inbox row exists.
   */
  idempotencyKey: string | null;
};

/**
 * What `insertInboxEvent` did with an arrival. A new arrival has its inbox row
 * and its delivery schedule row. A duplicate is answered with the inbox row
 * that holds its key, and nothing was written.
 */
export type InboxInsert =
  | { duplicate: false; inboxId: string; scheduleId: string }
  | { duplicate: true; inboxId: string };

/** One row of `workflow_event_inbox`, by where its delivery stands. */
export type InboxEvent = NewInboxEvent & {
  id: string;
  receivedAt: Date;
} & (
    | { status: "pending" }
    | { status: "delivered"; settledAt: Date }
    | { status: "failed"; settledAt: Date; error: string }
  );

/** A delivery schedule row the poll gave to an inbox row that had none. */
export type ScheduledDelivery = { scheduleId: string; inboxId: string };

/** What a start answers when no Entity admission decision is in play. */
export type ConcurrencyStartOutcome = Extract<
  EntityStartOutcome,
  { status: "started" | "refused" }
>;

/**
 * A Refused Start for a cron slot, written as a workflow-scoped `run_refused`
 * audit row. The slot is decided inside the write's own transaction, so the
 * caller hands the entry over as a function of it.
 */
export type CronRefusedEntry = (slot: Date) => {
  message: string;
  metadata: JsonObject;
};

/**
 * What `ExecutionRepo.fireCronTimer` is asked to do: fire the leased timer
 * `fence` names, admitting the run the way a manual start of the published
 * version that names no Event is admitted.
 */
export type FireCronTimerInput = {
  fence: CronFence;
  /** The schedule the claimed row times. */
  schedule: CronSchedule;
  /**
   * What the caller's preflight checked: the published version, the
   * workflow's Published mode, and the schedules that version declares. The
   * fire commits only while the workflow still publishes this version in this
   * mode.
   */
  expected: {
    versionId: string;
    mode: WorkflowMode;
    schedules: readonly CronSchedule[];
  };
  /**
   * The run to open, as `startForEntity` takes it. The fire writes the slot it
   * computed and `schedule` onto the row as `scheduled`.
   */
  start: Omit<StartForEntityInput, "now" | "admissionDecisionId">;
  /**
   * The Refused Start a first-wins refusal writes. The fire adds the ids of
   * the runs it deferred to under `inFlightExecutionIds`.
   */
  refusedEntry: CronRefusedEntry;
  /** The fire's clock: the slot it fires and the next wake are read from it. */
  now: Date;
};

/**
 * What a fire did.
 *
 * - `fired`: the transaction opened the run, or wrote a Refused Start, for
 *   `slot`, and moved the timer to `nextWakeAt` with its lease released.
 * - `stale`: the workflow publishes another version, or runs in another
 *   Published mode, than the caller's preflight checked. Nothing was written,
 *   and the caller checks the version it now publishes and fires again.
 * - `dropped`: the timer should not exist, because its workflow is paused,
 *   unpublished, or publishes no such schedule. The transaction deleted it.
 */
export type CronFire =
  | {
      kind: "fired";
      slot: Date;
      nextWakeAt: Date;
      start: ConcurrencyStartOutcome;
    }
  | { kind: "stale" }
  | {
      kind: "dropped";
      reason: "workflow_paused" | "not_published" | "schedule_unpublished";
    };
