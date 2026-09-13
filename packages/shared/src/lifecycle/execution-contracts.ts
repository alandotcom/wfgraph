/**
 * Every status an Execution can hold, and the one place the vocabulary is
 * written: the column's type, the RPC literals, and the run-history filter all
 * derive from this list.
 *
 * An Execution ends with exactly one terminal outcome (CONTEXT.md). `superseded` is how
 * newest-wins Concurrency ends a run a newer start displaced, which is quiet:
 * no outlet fires and the status is the whole of the record.
 */
export const WORKFLOW_EXECUTION_STATUSES = [
  "pending",
  "running",
  "waiting",
  "completed",
  "canceled",
  "exited",
  "superseded",
  "failed",
] as const;

export type WorkflowExecutionStatus =
  (typeof WORKFLOW_EXECUTION_STATUSES)[number];

/**
 * Which side of the Lifecycle Node a piece of work sits on: the Started outlet's
 * branch, or the Canceled outlet's.
 *
 * A Cancel claim ends the Started side and starts the Canceled one, so every
 * write that admits, parks or resumes work states which side it is for. A write
 * gets that side by reading the graph at the node the write is for, which
 * answers the same on a replay as on the first attempt because the outlet a node
 * sits behind is a property of the graph.
 */
export const EXECUTION_SIDES = ["started", "canceled"] as const;

export type ExecutionSide = (typeof EXECUTION_SIDES)[number];

/**
 * How a run was claimed for termination: by a Cancel Event, or by an Entity
 * Eligibility Exit.
 */
export const TERMINATION_KINDS = ["cancel", "exit"] as const;

export type TerminationKind = (typeof TERMINATION_KINDS)[number];

/**
 * Whether a run carrying this termination claim admits work on one side of the
 * Lifecycle Node.
 *
 * Started-side work needs an unclaimed run, because a Cancel claim and an Exit
 * claim both end the branch the run was walking. A Cancel claim is what starts
 * Canceled-side work, so that claim admits the Canceled side. An Exit claim
 * takes no graph outlet and admits neither side.
 *
 * This is the whole of the rule. Each persistence backend builds its own SQL
 * guard from it, and the engine asks it of a claim already read back off a row.
 */
export function claimKindAdmits(
  kind: TerminationKind | null,
  side: ExecutionSide
): boolean {
  return side === "canceled" ? kind === "cancel" : kind === null;
}

/** Why Entity Eligibility refused admission or exited an active Execution. */
export const ENTITY_ELIGIBILITY_REASONS = [
  "entity_condition_not_met",
  "entity_not_found",
] as const;

export type EntityEligibilityReason =
  (typeof ENTITY_ELIGIBILITY_REASONS)[number];

export function isEntityEligibilityReason(
  value: unknown
): value is EntityEligibilityReason {
  return ENTITY_ELIGIBILITY_REASONS.some((reason) => reason === value);
}

/**
 * The statuses a run can still leave.
 *
 * Every terminal write guards on this list, so a run that reached a verdict keeps
 * it: a cancel arriving after a completion changes nothing. The partial index over
 * in-flight rows is built from it too, so the query the guard makes and the index
 * that serves it cannot drift, and the client's "still worth polling" check reads
 * the same three words.
 */
export const IN_FLIGHT_EXECUTION_STATUSES = [
  "pending",
  "running",
  "waiting",
] as const satisfies readonly WorkflowExecutionStatus[];

/**
 * What opened a run. A schedule tick and a manual start carry no payload, so
 * both use the workflow itself as their Entity Value.
 */
export const WORKFLOW_EXECUTION_START_SOURCES = [
  "event",
  "schedule",
  "manual",
] as const;

export type WorkflowExecutionStartSource =
  (typeof WORKFLOW_EXECUTION_START_SOURCES)[number];

/**
 * Why a request produced no new run: the RPC contract's literal union and this
 * type union both derive from it, so the two cannot drift.
 *
 * - `workflow_paused`: the workflow is paused.
 * - `concurrency_first_wins`: a run for this entity is already in flight and
 *   the workflow's Concurrency is first-wins.
 * - `entity_value_missing`: the payload carried nothing at the Correlation Path
 *   while Concurrency compares, so there was no entity to be one-at-a-time about.
 * - `manual_start_not_allowed`: the workflow's Lifecycle Rules do not list manual
 *   runs as a start source.
 * - `start_event_required`: the graph holds an Event Split, which routes on the
 *   Event a run is on, and this start named none. Such a run reaches the split
 *   and stops there, so it is refused instead of started.
 * - `start_filter_not_met`: the payload did not satisfy the Start Filter this
 *   workflow put on that Start Event.
 * - `start_filter_unevaluable`: the Start Filter could not be read against the
 *   payload at all, which a payload carrying a field of the wrong type does.
 * - `entity_condition_not_met`: current Entity State did not satisfy the
 *   workflow's positive Entity Eligibility condition.
 * - `entity_not_found`: the host reported that the tracked Entity no longer
 *   exists.
 *
 * The two Start Filter reasons reach no manual start, because a manual start is a person asking
 * for this run rather than an arrival being admitted. They are listed here so the
 * sentence every refusal is recorded with keeps one home,
 * `buildIgnoredRunAuditMessage`.
 */
export const WORKFLOW_EXECUTION_IGNORED_REASONS = [
  "workflow_paused",
  "concurrency_first_wins",
  "entity_value_missing",
  "manual_start_not_allowed",
  "start_event_required",
  "start_filter_not_met",
  "start_filter_unevaluable",
  "entity_condition_not_met",
  "entity_not_found",
] as const;

export type WorkflowExecutionIgnoredReason =
  (typeof WORKFLOW_EXECUTION_IGNORED_REASONS)[number];

export type WorkflowExecutionRunningResponse = {
  status: "running";
  executionId: string;
  runId?: string;
  runMode: "live" | "test";
  /**
   * How many in-flight runs newest-wins Concurrency ended to make room for this
   * one. Absent means none, which is every start under first-wins or unlimited.
   */
  supersededExecutions?: number;
  /**
   * Runs marked superseded that no cancel signal reached, so each may still be
   * live. Absent is the ordinary case; present means this start half-landed.
   */
  failedToSupersede?: string[];
};

export type WorkflowExecutionIgnoredResponse = {
  status: "ignored";
  executionId?: string;
  runMode: "live" | "test";
  reason: WorkflowExecutionIgnoredReason;
};

export type WorkflowExecuteResponse =
  | WorkflowExecutionRunningResponse
  | WorkflowExecutionIgnoredResponse;
