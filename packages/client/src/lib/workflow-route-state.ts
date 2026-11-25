import { ApiError } from "#src/lib/rpc-client";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";

export type WorkflowLoadFailure = {
  notFound: boolean;
  message: string | null;
};

export const WORKFLOW_LOAD_ERROR_MESSAGE =
  "The workflow could not be loaded. Try again.";

function searchString(search: unknown, key: string): string | undefined {
  if (typeof search !== "object" || search === null || !(key in search)) {
    return undefined;
  }
  const value: unknown = Reflect.get(search, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The editor route search the viewer may open. A value that is not a
 * non-empty string is dropped. A run belongs to `view=runs`, and a view the
 * viewer cannot open falls back to Draft along with the run it named. A link
 * naming `view=changes`, or `review=true`, asks Draft to open the review sheet
 * for a viewer who may review and publish.
 */
export function authorizedWorkflowSearch(
  search: unknown,
  access: { canOpenRuns: boolean; canReview: boolean }
): WorkflowRouteSearch {
  const view = searchString(search, "view");
  const group = searchString(search, "group");
  const result: WorkflowRouteSearch = {};
  if (view === "runs" && access.canOpenRuns) {
    result.view = "runs";
    const executionId = searchString(search, "executionId");
    if (executionId !== undefined) {
      result.executionId = executionId;
    }
  } else if (
    access.canReview &&
    (view === "changes" || searchFlag(search, "review"))
  ) {
    result.review = true;
  }
  if (group !== undefined) {
    result.group = group;
  }
  return result;
}

/** Whether `key` holds true, or the text "true" a typed URL carries. */
function searchFlag(search: unknown, key: string): boolean {
  if (typeof search !== "object" || search === null || !(key in search)) {
    return false;
  }
  const value: unknown = Reflect.get(search, key);
  return value === true || value === "true";
}

/** Whether a request failed because the thing it named does not exist. */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function classifyWorkflowLoadFailure(
  error: unknown
): WorkflowLoadFailure {
  return isNotFoundError(error)
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
