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

/**
 * The tab a deep-linked run asks the panel to open, or null when the URL names
 * no run and the panel's own tab stands.
 *
 * Opening only, never closing. Closing a run from the panel's Back button is a
 * step back inside the Runs tab to its list, so a rule that read the absent
 * `executionId` as "leave Runs" sent that button to Properties instead, and the
 * runs list its label promises never came back. What does leave the tab is
 * `useLeaveRunsSurface`, at the interactions that take the whole panel off
 * screen.
 */
export function workflowPanelTab(
  executionId: string | undefined
): "runs" | null {
  return executionId ? "runs" : null;
}
