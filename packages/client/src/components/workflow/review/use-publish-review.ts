/**
 * The decision at the foot of the review sheet: publish the draft the sheet
 * reviews, or keep editing. Publish sends the exact snapshot the review was
 * built on, pinned to the draft revision and publication it compared against,
 * and answers each coded conflict in the reader's terms.
 */

import {
  type QueryClient,
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { can } from "#src/lib/authorization";
import { publishWarningMessage } from "#src/lib/publish-warnings";
import { ApiError } from "#src/lib/rpc-client";
import {
  cacheWorkflowPublication,
  orpcQuery,
  refreshWorkflowList,
  refreshWorkflowPublication,
  refreshWorkflowVersionHistory,
} from "#src/lib/rpc-query";
import {
  clearPublicationReviewAtom,
  isPublicationReviewPendingAtom,
  publicationReviewAtom,
} from "#src/lib/workflow-publication-review-store";
import { clearReviewPagesAtom } from "#src/lib/workflow-review-store";
import {
  currentWorkflowIdAtom,
  recordLoadedDraftRevisionAtom,
} from "#src/lib/workflow-save-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import {
  DRAFT_CONFLICT_CODE,
  isPublicationConflictCode,
  PUBLICATION_CONFLICT_CODES,
  type PublicationConflictCode,
} from "@wfgraph/shared/rpc/error-codes";

/**
 * Which conflict a refused publish is, read off the failure's code: one of the
 * two publication conflicts, or the draft revision the review pinned no longer
 * being the stored one. The message beside the code is written for a person
 * and may be reworded, so nothing here looks at it.
 */
function publicationConflictCode(
  error: unknown
): PublicationConflictCode | typeof DRAFT_CONFLICT_CODE | undefined {
  const code = error instanceof ApiError ? error.code : undefined;
  return isPublicationConflictCode(code) || code === DRAFT_CONFLICT_CODE
    ? code
    : undefined;
}

/**
 * Mark the workflow as having nothing unpublished and say so. Publish finding
 * no changes and the server refusing a publish for the same reason both land
 * here, so the reader sees one sentence either way.
 */
export function reportNothingToPublish(
  queryClient: QueryClient,
  workflowId: string
): void {
  cacheWorkflowPublication(queryClient, {
    id: workflowId,
    hasUnpublishedChanges: false,
  });
  toast.info("No changes to publish");
}

/** Whether a publish request is in flight anywhere in the editor. */
export function useIsPublishing(): boolean {
  return (
    useIsMutating({
      mutationKey: orpcQuery.workflow.publish.mutationKey(),
    }) > 0
  );
}

export type PublishReviewActions = {
  /** Publish the reviewed snapshot. */
  confirmPublish: () => void;
  /** Close the sheet and return the canvas to editing. */
  keepEditing: () => void;
  isPublishing: boolean;
};

export function usePublishReview(): PublishReviewActions {
  const queryClient = useQueryClient();
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const publishReview = useAtomValue(publicationReviewAtom);
  const reviewPending = useAtomValue(isPublicationReviewPendingAtom);
  const clearPublicationReview = useSetAtom(clearPublicationReviewAtom);
  const clearReviewPages = useSetAtom(clearReviewPagesAtom);
  const recordLoadedDraftRevision = useSetAtom(recordLoadedDraftRevisionAtom);
  const canPublish = can(WfGraphOperations.workflowPublish.id);
  const publishingReviewRef = useRef<string | null>(null);
  const isPublishing = useIsPublishing();

  // The three coded conflicts are answered below in the reader's terms, so
  // the cache's own toast would say it a second time. Only those three are
  // claimed: a per-mutate onError is skipped once the component that called
  // mutate has unmounted, and a generic failure the reader has navigated away
  // from must still reach a toast.
  const publishWorkflow = useMutation(
    orpcQuery.workflow.publish.mutationOptions({
      meta: {
        errorShownByCaller: (error) =>
          publicationConflictCode(error) !== undefined,
      },
    })
  );

  const confirmPublish = () => {
    if (!publishReview || reviewPending || !canPublish) {
      return;
    }
    if (publishReview.workflowId !== currentWorkflowId) {
      clearPublicationReview({
        workflowId: publishReview.workflowId,
        epoch: publishReview.epoch,
      });
      return;
    }
    const publishingKey = `${publishReview.workflowId}:${publishReview.epoch}`;
    if (publishingReviewRef.current === publishingKey) {
      return;
    }
    publishingReviewRef.current = publishingKey;
    const review = publishReview;
    publishWorkflow.mutate(
      {
        workflowId: review.workflowId,
        graph: review.graph,
        expectedPublishedVersionId: review.expectedPublishedVersionId,
        expectedDraftRevision: review.expectedDraftRevision,
      },
      {
        onSuccess: (payload) => {
          // The version exists whether or not the review that asked for it is
          // still open, and any route load ends every review. Only closing
          // the review is held to its epoch.
          toast.success(`Published v${payload.publishedVersion}`);
          // A warning never stops a publish, so each one follows the success.
          for (const warning of payload.warnings) {
            const message = publishWarningMessage(warning);
            toast.warning(message.title, { description: message.description });
          }
          recordLoadedDraftRevision({
            workflowId: payload.id,
            draftRevision: payload.draftRevision,
          });
          cacheWorkflowPublication(queryClient, payload);
          void refreshWorkflowList(queryClient);
          void refreshWorkflowVersionHistory(queryClient);
          if (
            clearPublicationReview({
              workflowId: payload.id,
              epoch: review.epoch,
            })
          ) {
            clearReviewPages(payload.id);
          }
        },
        onError: (error) => {
          const conflict = publicationConflictCode(error);
          if (!conflict) {
            // The mutation cache says what the server said, and the sheet
            // stays open to try again.
            return;
          }
          // Every coded conflict ends the review this attempt was built on.
          // The epoch stops a late answer from closing a review opened since.
          if (
            !clearPublicationReview({
              workflowId: review.workflowId,
              epoch: review.epoch,
            })
          ) {
            return;
          }
          clearReviewPages(review.workflowId);
          if (conflict === DRAFT_CONFLICT_CODE) {
            // The draft was saved elsewhere after the review pinned its
            // revision, so this review can never succeed. Ending it releases
            // the editing lock, which lets the draft sync install the newer
            // draft on a clean canvas or report it beside unsaved edits.
            toast.error(
              "The draft changed while you were reviewing. Publish again to review the current draft."
            );
            return;
          }
          if (conflict === PUBLICATION_CONFLICT_CODES.stale) {
            // The version this draft was compared against is no longer the
            // current one, so the edits the reader approved no longer
            // describe what publishing would do.
            void refreshWorkflowPublication(queryClient, review.workflowId);
            void refreshWorkflowVersionHistory(queryClient);
            toast.error(
              "Someone published a newer version while you were reviewing. Publish again to compare against it."
            );
            return;
          }
          reportNothingToPublish(queryClient, review.workflowId);
        },
        onSettled: () => {
          if (publishingReviewRef.current === publishingKey) {
            publishingReviewRef.current = null;
          }
        },
      }
    );
  };

  /**
   * Ends the review by workflow and epoch, so a late answer cannot end a
   * review opened since. While the review is still pending there is no review
   * to name, so the open workflow's id ends that session.
   */
  const keepEditing = useCallback(() => {
    if (publishReview) {
      clearPublicationReview({
        workflowId: publishReview.workflowId,
        epoch: publishReview.epoch,
      });
      clearReviewPages(publishReview.workflowId);
      return;
    }
    if (currentWorkflowId) {
      clearPublicationReview(currentWorkflowId);
      clearReviewPages(currentWorkflowId);
    }
  }, [
    clearPublicationReview,
    clearReviewPages,
    currentWorkflowId,
    publishReview,
  ]);

  return { confirmPublish, keepEditing, isPublishing };
}
