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
  runMode: "live" | "test";
  cancelledExecutions?: number;
  cancelledWaits?: number;
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

export type WorkflowWebhookResponse =
  | WorkflowExecutionRunningResponse
  | WorkflowExecutionCancelledResponse
  | WorkflowExecutionIgnoredResponse
  | WorkflowExecutionResumedResponse;
