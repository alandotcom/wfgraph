import { ApiError } from "#src/lib/rpc-client";

export type WorkflowLoadFailure = {
  notFound: boolean;
  message: string | null;
};

export const WORKFLOW_LOAD_ERROR_MESSAGE =
  "The workflow could not be loaded. Try again.";

export function classifyWorkflowLoadFailure(
  error: unknown
): WorkflowLoadFailure {
  return error instanceof ApiError && error.status === 404
    ? { notFound: true, message: null }
    : {
        notFound: false,
        message: WORKFLOW_LOAD_ERROR_MESSAGE,
      };
}

export function workflowPanelTab(executionId: string | undefined): string {
  return executionId ? "runs" : "properties";
}
