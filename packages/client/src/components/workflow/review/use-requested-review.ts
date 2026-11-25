/**
 * Opens the review sheet a route asked for, such as a link to the Changes view
 * the editor once had, once the workflow has settled: its draft is loaded, its
 * publication is read, and no save, check, comparison or publish is running.
 * It then runs the path Publish runs, once, so a draft with blocking issues
 * lists them and a draft with no change says so.
 */

import { useAtomValue, useStore } from "jotai";
import type { WorkflowToolbarActions } from "#src/components/workflow/workflow-toolbar-handlers";
import type { WorkflowToolbarState } from "#src/components/workflow/workflow-toolbar-state";
import { useAfterCommit } from "#src/hooks/effects";
import { isPublicationReviewActiveAtom } from "#src/lib/workflow-publication-review-store";
import { requestedReviewAtom } from "#src/lib/workflow-review-store";

export function useRequestedReview(
  state: WorkflowToolbarState,
  actions: WorkflowToolbarActions
): void {
  const store = useStore();
  const requested = useAtomValue(requestedReviewAtom);
  const workflowId = state.currentWorkflowId;
  const settled =
    state.publication !== undefined &&
    state.nodes.some((node) => node.type !== "add") &&
    !state.isSaving &&
    !state.isGenerating &&
    !actions.isComparing &&
    !actions.isPublishing &&
    !actions.isPreflighting;
  useAfterCommit(
    settled && requested !== null && requested === workflowId
      ? requested
      : null,
    () => {
      // The effect also runs on mount, so the conditions are read again here.
      if (!settled || store.get(requestedReviewAtom) !== workflowId) return;
      store.set(requestedReviewAtom, null);
      // A review already open or being prepared answers the request.
      if (store.get(isPublicationReviewActiveAtom)) return;
      void actions.handlePublish();
    }
  );
}
