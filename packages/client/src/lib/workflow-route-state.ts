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

/** Removes a run selection when the current authorization cannot open it. */
export function authorizedWorkflowSearch(
  search: unknown,
  canOpenRun: boolean
): { executionId?: string | undefined } {
  return canOpenRun
    ? { executionId: executionIdFromWorkflowSearch(search) }
    : {};
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

type WorkflowLoadSnapshot<T> = {
  workflow: T;
  saveGeneration: number;
};

/**
 * Refetch a workflow when a save completed during its route load.
 *
 * A save can also complete during the replacement request, so the generation
 * must remain unchanged across one complete fetch before the snapshot is safe
 * to hydrate. The callback runs in the same task as the final generation check,
 * which closes the race between accepting and publishing the snapshot. Route
 * cancellation suppresses the result of an in-flight fetch.
 */
export async function publishWorkflowAfterCompletedSaves<T>({
  workflow,
  saveGeneration,
  getSaveGeneration,
  fetchWorkflow,
  publishWorkflow,
  signal,
}: WorkflowLoadSnapshot<T> & {
  getSaveGeneration: () => number;
  fetchWorkflow: () => Promise<T>;
  publishWorkflow: (snapshot: WorkflowLoadSnapshot<T>) => void;
  signal: AbortSignal;
}): Promise<boolean> {
  let snapshot = { workflow, saveGeneration };

  while (!signal.aborted) {
    const latestSaveGeneration = getSaveGeneration();
    if (latestSaveGeneration === snapshot.saveGeneration) {
      publishWorkflow(snapshot);
      return true;
    }

    snapshot = {
      saveGeneration: latestSaveGeneration,
      // eslint-disable-next-line no-await-in-loop -- each replacement must start after the save that invalidated its predecessor.
      workflow: await fetchWorkflow(),
    };
  }

  return false;
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
