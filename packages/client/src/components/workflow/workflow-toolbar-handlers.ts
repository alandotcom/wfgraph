/**
 * The workflow-level menu actions: save, clear, delete, duplicate, and the
 * publish review. The run pipeline lives in `workflow-run-handlers`; chrome
 * components live beside this file.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { WorkflowIssuesOverlay } from "#src/components/overlays/workflow-issues-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useDeleteWorkflow } from "#src/hooks/use-delete-workflow";
import { useDomEvent } from "#src/hooks/effects";
import {
  PREFLIGHT_BUSY_MESSAGE,
  useWorkflowIssuePreflight,
} from "#src/hooks/use-workflow-issue-preflight";
import { isTextEntry } from "#src/lib/is-text-entry";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  cacheWorkflowPublication,
  orpcQuery,
  refreshWorkflowList,
  refreshWorkflowPublication,
  refreshWorkflowVersionHistory,
} from "#src/lib/rpc-query";
import type { WorkflowRunGraph } from "#src/lib/workflow-run-labels";
import {
  recordLoadedDraftRevisionAtom,
  saveWorkflowAtom,
} from "#src/lib/workflow-save-store";
import { ApiError, toSerializedGraph } from "#src/lib/rpc-client";
import {
  isPublicationConflictCode,
  PUBLICATION_CONFLICT_CODES,
  type PublicationConflictCode,
} from "@wfgraph/shared/rpc/error-codes";
import { publicationReviewFromComparison } from "#src/components/workflow/publish-review-dialog";
import {
  beginPublicationReviewAtom,
  clearPublicationReviewAtom,
  installPublicationReviewAtom,
  isPublicationReviewActiveAtom,
  isPublicationReviewPendingAtom,
  publicationReviewAtom,
  type ReadyPublicationReview,
  settlePublicationReviewAtom,
} from "#src/lib/workflow-publication-review-store";
import {
  groupWorkflowIssuesForOverlay,
  hasBlockingWorkflowIssues,
} from "@wfgraph/shared/graph/workflow-issues";
import type { WorkflowToolbarState } from "#src/components/workflow/workflow-toolbar-state";
import {
  PREFLIGHT_TOAST_ID,
  useWorkflowHandlers,
} from "#src/components/workflow/workflow-run-handlers";

/**
 * Which publication conflict a refused publish is, read off the failure's code.
 *
 * The message beside the code is written for a person and may be reworded, so
 * nothing here looks at it.
 */
function publicationConflictCode(
  error: unknown
): PublicationConflictCode | undefined {
  const code = error instanceof ApiError ? error.code : undefined;
  return isPublicationConflictCode(code) ? code : undefined;
}

/**
 * What the toolbar chrome, the overflow menu, and the command palette call.
 * Each write reports whether it is already running, because the control that
 * starts it is disabled while it runs.
 */
export type WorkflowToolbarActions = {
  handleSave: () => Promise<void>;
  handleExecute: (graph: WorkflowRunGraph) => Promise<void>;
  handleClearWorkflow: () => void;
  handleDeleteWorkflow: () => void;
  /** Re-reads the workflow list the switcher draws. */
  loadWorkflows: () => Promise<void>;
  handleDuplicate: () => void;
  isDuplicating: boolean;
  handlePublish: () => Promise<void>;
  confirmPublish: () => void;
  isPublishing: boolean;
  isComparing: boolean;
  isPreflighting: boolean;
  /** The review a publish is waiting on, null while no review is open. */
  publishReview: ReadyPublicationReview | null;
  setPublishReviewOpen: (open: boolean) => void;
};

export function useWorkflowActions(
  state: WorkflowToolbarState
): WorkflowToolbarActions {
  const { open: openOverlay } = useOverlay();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deleteWorkflow = useDeleteWorkflow();
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const recordLoadedDraftRevision = useSetAtom(recordLoadedDraftRevisionAtom);
  const publishReview = useAtomValue(publicationReviewAtom);
  const publicationReviewActive = useAtomValue(isPublicationReviewActiveAtom);
  const publicationReviewPending = useAtomValue(isPublicationReviewPendingAtom);
  const beginPublicationReview = useSetAtom(beginPublicationReviewAtom);
  const installPublicationReview = useSetAtom(installPublicationReviewAtom);
  const clearPublicationReview = useSetAtom(clearPublicationReviewAtom);
  const settlePublicationReview = useSetAtom(settlePublicationReviewAtom);
  const publishingReviewRef = useRef<string | null>(null);
  // Only the fields this hook's own bodies read. The run and issue handlers
  // take the whole state and destructure it themselves.
  const {
    canDelete,
    canDuplicate,
    canExecute,
    canPublish,
    canUpdate,
    clearWorkflow,
    currentWorkflowId,
    edges,
    isGenerating,
    nodes,
    publication,
    userIntegrations,
    workflowName,
  } = state;
  const { checkWorkflowIssues, isPreflighting } =
    useWorkflowIssuePreflight(userIntegrations);
  const { handleExecute, handleGoToStep } = useWorkflowHandlers({
    state,
    checkWorkflowIssues,
    saveWorkflow,
  });

  const handleSave = useCallback(async () => {
    if (!currentWorkflowId || isGenerating || !canUpdate) {
      return;
    }
    const outcome = await saveWorkflow({ nodes, edges }, { immediate: true });
    if (outcome && !outcome.ok) {
      toast.error(outcome.error.message || "Failed to save workflow");
    }
  }, [canUpdate, currentWorkflowId, edges, isGenerating, nodes, saveWorkflow]);

  // Cmd+S shares the command palette's save path, so an explicit save and the
  // shortcut cannot race the autosave queue differently.
  const handleSaveShortcut = useCallback(
    (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        event.stopPropagation();
        void handleSave();
      }
    },
    [handleSave]
  );

  useDomEvent(document, "keydown", handleSaveShortcut, { capture: true });

  // Cmd+Enter runs the draft. The listener sits beside handleExecute so the
  // shortcut and the split button's face make the same call. A published run
  // has no shortcut, because it must be chosen by name.
  //
  // The listener runs in the capture phase, because a focused canvas node would
  // otherwise receive the keystroke first.
  //
  // A viewer who does not own the workflow sees no run controls, but this
  // listener is on the document rather than on a control, so it repeats the
  // owner check. Without it the shortcut would run a graph the viewer cannot
  // edit and flush the autosave queue on the way.
  const handleRunShortcut = useCallback(
    (event: KeyboardEvent) => {
      if (!((event.metaKey || event.ctrlKey) && event.key === "Enter")) {
        return;
      }
      if (!canExecute || !canUpdate || isTextEntry(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void handleExecute("draft");
    },
    [canExecute, canUpdate, handleExecute]
  );

  useDomEvent(document, "keydown", handleRunShortcut, { capture: true });

  const handleClearWorkflow = () => {
    if (!canUpdate) {
      return;
    }
    openOverlay(ConfirmOverlay, {
      title: "Clear Workflow",
      message:
        "Remove every step and connection? The Lifecycle Node is kept, and this saves right away.",
      confirmLabel: "Clear Workflow",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: () => {
        clearWorkflow();
      },
    });
  };

  const handleDeleteWorkflow = () => {
    if (!canDelete) {
      return;
    }
    openOverlay(ConfirmOverlay, {
      title: "Delete Workflow",
      message: `Are you sure you want to delete "${workflowName}"? This will permanently delete the workflow. This cannot be undone.`,
      confirmLabel: "Delete Workflow",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: () => {
        if (!currentWorkflowId) {
          return;
        }
        deleteWorkflow.mutate({ workflowId: currentWorkflowId });
      },
    });
  };

  // The switcher dropdown opening is a good moment to re-read the list, and a
  // create or a delete elsewhere invalidates the same key.
  const loadWorkflows = () => refreshWorkflowList(queryClient);

  const duplicateWorkflow = useMutation(
    orpcQuery.workflow.duplicate.mutationOptions({
      onSuccess: async (payload) => {
        toast.success("Workflow duplicated successfully");
        await loadWorkflows();
        await navigate({
          to: "/workflows/$workflowId",
          params: { workflowId: payload.id },
        });
      },
      meta: { errorMessage: "Failed to duplicate workflow. Please try again." },
    })
  );

  // Per-call callbacks run from the click that began this preflight. The hook
  // itself therefore remains a plain RPC declaration during render.
  const publishWorkflow = useMutation(
    orpcQuery.workflow.publish.mutationOptions({
      // The two coded publication conflicts are answered below in the
      // operator's terms, so the cache's own toast would say it a second time.
      // Only those two are claimed: a per-mutate onError is skipped once the
      // component that called mutate has unmounted, and a generic failure the
      // operator has navigated away from must still reach a toast.
      meta: {
        errorShownByCaller: (error) =>
          publicationConflictCode(error) !== undefined,
      },
    })
  );
  const compareWorkflowVersion = useMutation(
    orpcQuery.workflow.compareVersion.mutationOptions()
  );

  /**
   * Close the publication badge and say the draft is already published.
   *
   * Both the comparison finding no changes and the server refusing the publish
   * for the same reason land here, so the operator reads one sentence either
   * way and the badge stops claiming unpublished changes.
   */
  const reportNothingToPublish = (workflowId: string) => {
    cacheWorkflowPublication(queryClient, {
      id: workflowId,
      hasUnpublishedChanges: false,
    });
    toast.info("No changes to publish");
  };

  const handleDuplicate = () => {
    if (!currentWorkflowId || !canDuplicate) {
      return;
    }
    duplicateWorkflow.mutate({ workflowId: currentWorkflowId });
  };

  const handlePublish = async () => {
    if (!currentWorkflowId || !canPublish) {
      return;
    }
    if (publicationReviewActive) {
      toast.info(PREFLIGHT_BUSY_MESSAGE, { id: PREFLIGHT_TOAST_ID });
      return;
    }

    const epoch = beginPublicationReview(currentWorkflowId);
    if (epoch === null) {
      toast.info(PREFLIGHT_BUSY_MESSAGE, { id: PREFLIGHT_TOAST_ID });
      return;
    }
    const graph = toSerializedGraph({ nodes, edges });
    const saved = await saveWorkflow({ nodes, edges }, { immediate: true });
    if (!saved?.ok) {
      clearPublicationReview({ workflowId: currentWorkflowId, epoch });
      if (saved) {
        toast.error(saved.error.message || "Failed to save workflow");
      }
      return;
    }

    // Says the common half early: required fields and connections, which the
    // canvas has been badging all along. The server stays the authority and
    // asks more than this -- Events, Event Split outlets, template types,
    // unreachable subtrees -- so a graph can still be refused after passing
    // here. A draft saves in any state; this gate does not move, so there is no
    // Publish Anyway.
    const preflight = await checkWorkflowIssues({
      workflowId: currentWorkflowId,
      nodes,
    });
    if (preflight.status !== "ready") {
      clearPublicationReview({ workflowId: currentWorkflowId, epoch });
      if (preflight.status === "busy") {
        toast.info(PREFLIGHT_BUSY_MESSAGE, { id: PREFLIGHT_TOAST_ID });
      }
      return;
    }
    const { issues } = preflight;
    if (hasBlockingWorkflowIssues(issues)) {
      clearPublicationReview({ workflowId: currentWorkflowId, epoch });
      openOverlay(WorkflowIssuesOverlay, {
        issues: groupWorkflowIssuesForOverlay(issues),
        onGoToStep: handleGoToStep,
        allowRunDraftAnyway: false,
      });
      return;
    }

    const input = omitUndefined({
      workflowId: currentWorkflowId,
      baseVersionId: publication?.publishedVersionId,
      draftGraph: graph,
    });
    compareWorkflowVersion.mutate(input, {
      onSuccess: (comparison, comparisonInput) => {
        if (!comparison.hasChanges) {
          if (
            !clearPublicationReview({
              workflowId: comparisonInput.workflowId,
              epoch,
            })
          ) {
            return;
          }
          reportNothingToPublish(comparisonInput.workflowId);
          return;
        }

        installPublicationReview({
          workflowId: comparisonInput.workflowId,
          epoch,
          pending: false,
          graph: comparisonInput.draftGraph,
          expectedDraftRevision: saved.workflow.draftRevision,
          expectedPublishedVersionId: comparison.baseVersion?.id ?? null,
          review: publicationReviewFromComparison(comparison),
        });
      },
      onSettled: (comparison, _error, comparisonInput) => {
        if (!comparison?.hasChanges) {
          clearPublicationReview({
            workflowId: comparisonInput.workflowId,
            epoch,
          });
          return;
        }
        settlePublicationReview({
          workflowId: comparisonInput.workflowId,
          epoch,
        });
      },
    });
  };

  const confirmPublish = () => {
    if (!publishReview || publicationReviewPending || !canPublish) {
      return;
    }
    if (
      publishReview.workflowId !== currentWorkflowId ||
      !publicationReviewActive
    ) {
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
    publishWorkflow.mutate(
      {
        workflowId: publishReview.workflowId,
        graph: publishReview.graph,
        expectedPublishedVersionId: publishReview.expectedPublishedVersionId,
        expectedDraftRevision: publishReview.expectedDraftRevision,
      },
      {
        onSuccess: (payload) => {
          if (
            clearPublicationReview({
              workflowId: payload.id,
              epoch: publishReview.epoch,
            })
          ) {
            toast.success(`Published version ${payload.publishedVersion}`);
            recordLoadedDraftRevision({
              workflowId: payload.id,
              draftRevision: payload.draftRevision,
            });
            cacheWorkflowPublication(queryClient, payload);
            void loadWorkflows();
            void refreshWorkflowVersionHistory(queryClient);
          }
        },
        onError: (error) => {
          const conflict = publicationConflictCode(error);
          if (!conflict) {
            // Anything else keeps what a failed write has always done: the
            // mutation cache says what the server said, and the review stays
            // open to try again.
            return;
          }

          // Both coded conflicts end the review this attempt was built on. The
          // epoch is what stops a late answer from closing a review the
          // operator has opened since, exactly as the success path is held.
          if (
            !clearPublicationReview({
              workflowId: publishReview.workflowId,
              epoch: publishReview.epoch,
            })
          ) {
            return;
          }

          if (conflict === PUBLICATION_CONFLICT_CODES.stale) {
            // The version this draft was compared against is no longer the
            // current one, so the changes the operator approved no longer
            // describe what publishing would do. Read the publication state
            // back and leave them to review again; the canvas keeps the draft
            // it has.
            void refreshWorkflowPublication(
              queryClient,
              publishReview.workflowId
            );
            void refreshWorkflowVersionHistory(queryClient);
            toast.error(
              "Someone published a newer version while you were reviewing. Publish again to compare against it."
            );
            return;
          }

          reportNothingToPublish(publishReview.workflowId);
        },
        onSettled: (_payload, _error, _publishInput) => {
          if (publishingReviewRef.current === publishingKey) {
            publishingReviewRef.current = null;
          }
        },
      }
    );
  };

  /**
   * The publish review dialog's open state. Opening does nothing, because
   * `handlePublish` opens a review.
   *
   * Closing ends the review by workflow and epoch, so a late answer cannot end
   * a review the operator opened since. A dialog closing while the review is
   * still pending has no review to name, so the open workflow's id ends that
   * session instead.
   */
  const setPublishReviewOpen = useCallback(
    (open: boolean) => {
      if (!open) {
        const workflowId =
          publishReview?.workflowId ?? currentWorkflowId ?? undefined;
        if (publishReview) {
          clearPublicationReview({
            workflowId: publishReview.workflowId,
            epoch: publishReview.epoch,
          });
        } else {
          clearPublicationReview(workflowId);
        }
      }
    },
    [clearPublicationReview, currentWorkflowId, publishReview]
  );

  return {
    handleSave,
    handleExecute,
    handleClearWorkflow,
    handleDeleteWorkflow,
    loadWorkflows,
    handleDuplicate,
    isDuplicating: duplicateWorkflow.isPending,
    handlePublish,
    confirmPublish,
    isPublishing: publishWorkflow.isPending,
    isComparing: compareWorkflowVersion.isPending,
    isPreflighting,
    publishReview,
    setPublishReviewOpen,
  };
}
