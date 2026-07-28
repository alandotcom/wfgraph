/**
 * The single source for ignore reasons: the RPC contract's zod enum and this
 * union both derive from it, so the two cannot drift.
 *
 * - `missing_event_type`: the payload classified to no Event Type.
 * - `invalid_payload`: the payload failed the trigger's schema.
 * - `event_not_mapped`: the Routing Policy maps this Event Type to ignore,
 *   or does not map it at all.
 * - `no_in_flight_runs`: a cancel action found nothing to cancel.
 * - `workflow_paused`: the workflow is paused.
 */
export const WORKFLOW_EXECUTION_IGNORED_REASONS = [
  "missing_event_type",
  "invalid_payload",
  "event_not_mapped",
  "no_in_flight_runs",
  "workflow_paused",
] as const;

export type WorkflowExecutionIgnoredReason =
  (typeof WORKFLOW_EXECUTION_IGNORED_REASONS)[number];

export type WorkflowExecutionRunningResponse = {
  status: "running";
  executionId: string;
  runId?: string;
  runMode: "live" | "test";
  cancelledExecutions?: number;
  cancelledWaits?: number;
  /**
   * Executions a Replace tried and failed to cancel. Without this, a
   * half-failed Replace reads as one clean new run while the old ones are
   * still live.
   */
  failedExecutions?: string[];
};

export type WorkflowExecutionCancelledResponse = {
  status: "cancelled";
  executionId?: string;
  runMode: "live" | "test";
  cancelledExecutions: number;
  cancelledWaits: number;
  failedExecutions?: string[];
};

export type WorkflowExecutionIgnoredResponse = {
  status: "ignored";
  executionId?: string;
  runMode: "live" | "test";
  reason: WorkflowExecutionIgnoredReason;
};

export type WorkflowExecutionResumedResponse = {
  status: "resumed";
  resumedCount: number;
  runMode: "live" | "test";
};

export type WorkflowExecuteResponse =
  | WorkflowExecutionRunningResponse
  | (WorkflowExecutionCancelledResponse & { executionId: string })
  | (WorkflowExecutionIgnoredResponse & { executionId: string });
