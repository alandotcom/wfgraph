export type WorkflowExecutionStatus =
  | "running"
  | "cancelled"
  | "ignored"
  | "resumed";

export type WorkflowExecutionIgnoredReason =
  | "missing_event_type"
  | "event_not_configured"
  | "no_waiting_runs"
  | "workflow_paused";

export type WorkflowExecutionRunningResponse = {
  status: "running";
  executionId: string;
  runId?: string;
  dryRun: boolean;
  cancelledExecutions?: number;
  cancelledWaits?: number;
  simulated?: boolean;
};

export type WorkflowExecutionCancelledResponse = {
  status: "cancelled";
  executionId?: string;
  dryRun: boolean;
  cancelledExecutions: number;
  cancelledWaits: number;
  simulated?: boolean;
  failedExecutions?: string[];
};

export type WorkflowExecutionIgnoredResponse = {
  status: "ignored";
  executionId?: string;
  dryRun?: boolean;
  reason: WorkflowExecutionIgnoredReason;
  eventTypePath?: string;
};

export type WorkflowExecutionResumedResponse = {
  status: "resumed";
  resumedCount: number;
  dryRun?: boolean;
  simulated?: boolean;
};

export type WorkflowExecuteResponse =
  | WorkflowExecutionRunningResponse
  | (WorkflowExecutionCancelledResponse & { executionId: string })
  | (WorkflowExecutionIgnoredResponse & {
      executionId: string;
      dryRun: boolean;
    });

export type WorkflowWebhookResponse =
  | WorkflowExecutionRunningResponse
  | WorkflowExecutionCancelledResponse
  | WorkflowExecutionIgnoredResponse
  | WorkflowExecutionResumedResponse;
