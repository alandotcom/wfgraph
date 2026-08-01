/**
 * Every status an Execution can hold, and the one place the vocabulary is
 * written: the column's type, the RPC literals, and the run-history filter all
 * derive from this list.
 *
 * An Execution ends with exactly one of four (CONTEXT.md). `superseded` is how
 * newest-wins Concurrency ends a run a newer start displaced, which is quiet:
 * no outlet fires and the status is the whole of the record.
 */
export const WORKFLOW_EXECUTION_STATUSES = [
  "pending",
  "running",
  "waiting",
  "completed",
  "canceled",
  "superseded",
  "failed",
] as const;

export type WorkflowExecutionStatus =
  (typeof WORKFLOW_EXECUTION_STATUSES)[number];

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
 */
export const WORKFLOW_EXECUTION_IGNORED_REASONS = [
  "workflow_paused",
  "concurrency_first_wins",
  "entity_value_missing",
  "manual_start_not_allowed",
  "start_event_required",
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
