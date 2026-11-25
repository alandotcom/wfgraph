/**
 * The workflow-level menu actions: save, clear, delete, duplicate, and opening
 * the review sheet that Publish starts. The sheet's own decision lives in
 * `review/use-publish-review`, the run pipeline in `workflow-run-handlers`, and
 * chrome components beside this file.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import {
  WorkflowIssuesOverlay,
  type WorkflowIssuesOverlayInput,
} from "#src/components/overlays/workflow-issues-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useDeleteWorkflow } from "#src/hooks/use-delete-workflow";
import { useDomEvent } from "#src/hooks/effects";
import {
  PREFLIGHT_BUSY_MESSAGE,
  useWorkflowIssuePreflight,
} from "#src/hooks/use-workflow-issue-preflight";
import { editorChordAllowed, isSubmitChord } from "#src/lib/editor-shortcuts";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { orpcQuery, refreshWorkflowList } from "#src/lib/rpc-query";
import type { WorkflowRunGraph } from "#src/lib/workflow-run-labels";
import {
  currentWorkflowDraftRevisionAtom,
  saveWorkflowAtom,
} from "#src/lib/workflow-save-store";
import { toSerializedGraph } from "#src/lib/rpc-client";
import {
  reportNothingToPublish,
  useIsPublishing,
} from "#src/components/workflow/review/use-publish-review";
import {
  beginPublicationReviewAtom,
  clearPublicationReviewAtom,
  installPublicationReviewAtom,
  isPublicationReviewActiveAtom,
  publicationReviewSessionAtom,
} from "#src/lib/workflow-publication-review-store";
import { isReviewOpenAtom } from "#src/lib/workflow-review-store";
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
  /**
   * Save, check, and compare the draft, then open the review sheet on it.
   * "Review changes" runs the same path.
   */
  handlePublish: () => Promise<void>;
  isPublishing: boolean;
  isComparing: boolean;
  isPreflighting: boolean;
};

export function useWorkflowActions(
  state: WorkflowToolbarState
): WorkflowToolbarActions {
  const { open: openOverlay } = useOverlay();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const store = useStore();
  const deleteWorkflow = useDeleteWorkflow();
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const publicationReviewActive = useAtomValue(isPublicationReviewActiveAtom);
  const beginPublicationReview = useSetAtom(beginPublicationReviewAtom);
  const installPublicationReview = useSetAtom(installPublicationReviewAtom);
  const clearPublicationReview = useSetAtom(clearPublicationReviewAtom);
  const isPublishing = useIsPublishing();
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
    hasUnsavedChanges,
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
    await saveWorkflow({ nodes, edges }, { immediate: true });
  }, [canUpdate, currentWorkflowId, edges, isGenerating, nodes, saveWorkflow]);

  // Cmd+S shares the command palette's save path, so an explicit save and the
  // shortcut cannot race the autosave queue differently. The browser's own Save
  // page dialog is refused even while a dialog or menu holds the keyboard and
  // the save itself waits.
  const handleSaveShortcut = useCallback(
    (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        if (!editorChordAllowed(event, { inTextFields: true })) {
          return;
        }
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
  //
  // While the review sheet is open or Publish is preparing it, the shortcut
  // leaves the key alone, so the sheet's own Cmd+Enter publishes.
  const handleRunShortcut = useCallback(
    (event: KeyboardEvent) => {
      if (!isSubmitChord(event)) {
        return;
      }
      if (
        !canExecute ||
        !canUpdate ||
        store.get(isReviewOpenAtom) ||
        !editorChordAllowed(event, { inTextFields: false })
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void handleExecute("draft");
    },
    [canExecute, canUpdate, handleExecute, store]
  );

  useDomEvent(document, "keydown", handleRunShortcut, { capture: true });

  const handleClearWorkflow = () => {
    if (!canUpdate) {
      return;
    }
    openOverlay(ConfirmOverlay, {
      title: "Clear workflow",
      message:
        "Remove every step and connection? The Lifecycle Node is kept, and this saves right away.",
      confirmLabel: "Clear workflow",
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
      title: "Delete workflow",
      message: `Are you sure you want to delete "${workflowName}"? This will permanently delete the workflow. This cannot be undone.`,
      confirmLabel: "Delete workflow",
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

  // No errorMessage: each refused duplicate carries a server sentence naming
  // the cause and what to do next, and the mutation cache falls back to it.
  const duplicateWorkflow = useMutation(
    orpcQuery.workflow.duplicate.mutationOptions({
      onSuccess: async (payload) => {
        toast.success("Workflow duplicated");
        await loadWorkflows();
        await navigate({
          to: "/workflows/$workflowId",
          params: { workflowId: payload.id },
        });
      },
    })
  );

  const compareWorkflowVersion = useMutation(
    orpcQuery.workflow.compareVersion.mutationOptions()
  );

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
    // A route load or a cancel can end this review while the save or the
    // preflight runs, and an ended review must neither compare nor open the
    // issues list.
    const workflowId = currentWorkflowId;
    const reviewIsOpen = () => {
      const session = store.get(publicationReviewSessionAtom);
      return session?.workflowId === workflowId && session.epoch === epoch;
    };
    const graph = toSerializedGraph({ nodes, edges });
    // A draft with no unsaved edit is already the stored draft, so Publish
    // reviews it at the revision the editor holds. Saving it again would move
    // the status strip's "Saved" time and the workflow's "Updated" value with
    // nothing edited.
    let draftRevision = store.get(currentWorkflowDraftRevisionAtom);
    if (hasUnsavedChanges) {
      const saved = await saveWorkflow({ nodes, edges }, { immediate: true });
      if (!saved?.ok) {
        clearPublicationReview({ workflowId: currentWorkflowId, epoch });
        return;
      }
      draftRevision = saved.workflow.draftRevision;
    }
    if (!reviewIsOpen()) {
      return;
    }

    // Says the common half early: required fields, connections, and the Group
    // rules, which the canvas badges and which publication checks through the
    // same `groupContractViolations`. The server stays the authority and asks
    // more than this -- Events, Event Split outlets, template types,
    // unreachable subtrees -- so a graph can still be refused after passing
    // here. A draft saves in any state; this gate does not move, so there is
    // no Publish Anyway.
    const preflight = await checkWorkflowIssues({
      workflowId: currentWorkflowId,
      nodes,
      edges,
    });
    if (!reviewIsOpen()) {
      return;
    }
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
      openOverlay<WorkflowIssuesOverlayInput>(WorkflowIssuesOverlay, {
        issues: groupWorkflowIssuesForOverlay(issues),
        trigger: "publish",
        onGoToStep: handleGoToStep,
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
          reportNothingToPublish(queryClient, comparisonInput.workflowId);
          return;
        }

        installPublicationReview({
          workflowId: comparisonInput.workflowId,
          epoch,
          pending: false,
          graph,
          expectedDraftRevision: draftRevision,
          expectedPublishedVersionId: comparison.baseVersion?.id ?? null,
          payload: comparison,
        });
      },
      onSettled: (comparison, _error, comparisonInput) => {
        if (!comparison?.hasChanges) {
          clearPublicationReview({
            workflowId: comparisonInput.workflowId,
            epoch,
          });
        }
      },
    });
  };

  return {
    handleSave,
    handleExecute,
    handleClearWorkflow,
    handleDeleteWorkflow,
    loadWorkflows,
    handleDuplicate,
    isDuplicating: duplicateWorkflow.isPending,
    handlePublish,
    isPublishing,
    isComparing: compareWorkflowVersion.isPending,
    isPreflighting,
  };
}
