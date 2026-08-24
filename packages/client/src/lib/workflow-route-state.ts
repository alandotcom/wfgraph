import { ApiError } from "#src/lib/rpc-client";

export type WorkflowLoadFailure = {
  notFound: boolean;
  message: string | null;
};

export const WORKFLOW_LOAD_ERROR_MESSAGE =
  "The workflow could not be loaded. Try again.";

export function executionIdFromWorkflowSearch(
  search: unknown
): string | undefined {
  if (
    typeof search !== "object" ||
    search === null ||
    !("executionId" in search)
  ) {
    return undefined;
  }
  const executionId = search.executionId;
  return typeof executionId === "string" && executionId.length > 0
    ? executionId
    : undefined;
}

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
 * The workspace a deep-linked run opens, or null when the URL names no run and
 * the editor's current workspace stands.
 *
 * Opening only, never closing. Closing a run from the panel's Back button is a
 * step back inside the Runs workspace to its list, so a rule that read the absent
 * `executionId` as "leave Runs" sent that button to Properties instead, and the
 * runs list its label promises never came back. Workspace navigation, rather
 * than panel visibility, decides when Runs ends.
 */
export function workflowWorkspaceView(
  executionId: string | undefined
): "runs" | null {
  return executionId ? "runs" : null;
}
