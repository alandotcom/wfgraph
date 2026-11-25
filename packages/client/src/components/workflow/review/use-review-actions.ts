/**
 * What the review sheet's controls do other than publish: open version
 * history and a past version, step back and close, restore a version as the
 * draft, and show an edit's step on the canvas.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSetAtom, useStore } from "jotai";
import { toast } from "sonner";
import { can } from "#src/lib/authorization";
import { toSavedWorkflow } from "#src/lib/rpc-client";
import {
  cacheWorkflow,
  orpcQuery,
  refreshWorkflowList,
} from "#src/lib/rpc-query";
import {
  displayNodesAtom,
  edgesAtom,
  installRestoredWorkflowAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import { workspaceAddressId } from "#src/lib/workflow-navigation-state";
import { expandGroupAtom } from "#src/lib/collapsed-groups";
import { clearPublicationReviewAtom } from "#src/lib/workflow-publication-review-store";
import {
  clearReviewPagesAtom,
  closeReviewPageAtom,
  openReviewPageAtom,
  reviewHighlightAtom,
  settleVersionReviewAtom,
} from "#src/lib/workflow-review-store";
import {
  currentWorkflowDraftRevisionAtom,
  currentWorkflowIdAtom,
  saveWorkflowAtom,
} from "#src/lib/workflow-save-store";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { requestRevealPlacementAtom } from "../canvas-reveal/reveal-requests";

export type ReviewActions = {
  /** Whether the reader may open version history. */
  canReadHistory: boolean;
  /** Whether the reader may restore a version, which saves the draft first. */
  canRestore: boolean;
  openHistory: () => void;
  openVersion: (version: {
    id: string;
    version: number;
    isCurrent: boolean;
  }) => void;
  /** Show the page or review beneath the top page. */
  back: () => void;
  /** Close the sheet, ending the draft's review with it. */
  close: () => void;
  /** Restore a published version as the draft, then close the sheet. */
  restore: (versionId: string) => void;
  isRestoring: boolean;
  /**
   * Place a changed step in the canvas beside the sheet once, on the focused
   * canvas of its Group when it sits inside one, and point at its card.
   */
  showOnCanvas: (nodeId: string) => void;
};

export function useReviewActions(): ReviewActions {
  const store = useStore();
  const queryClient = useQueryClient();
  const openPage = useSetAtom(openReviewPageAtom);
  const closePage = useSetAtom(closeReviewPageAtom);
  const clearPages = useSetAtom(clearReviewPagesAtom);
  const clearPublicationReview = useSetAtom(clearPublicationReviewAtom);
  const settleVersion = useSetAtom(settleVersionReviewAtom);
  const setHighlight = useSetAtom(reviewHighlightAtom);
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  const installRestoredWorkflow = useSetAtom(installRestoredWorkflowAtom);
  const saveWorkflow = useSetAtom(saveWorkflowAtom);
  const canReadHistory = can(WfGraphOperations.workflowGetVersionHistory.id);
  const canRestore =
    can(WfGraphOperations.workflowRestoreVersion.id) &&
    can(WfGraphOperations.workflowUpdate.id);

  const compare = useMutation(
    orpcQuery.workflow.compareVersion.mutationOptions({
      meta: { errorMessage: "Unable to read what this version changed" },
    })
  );

  const workflowId = () => store.get(currentWorkflowIdAtom);

  const openHistory = () => {
    const id = workflowId();
    if (id && canReadHistory) {
      openPage({ workflowId: id, page: { kind: "history" } });
    }
  };

  const openVersion = (version: {
    id: string;
    version: number;
    isCurrent: boolean;
  }) => {
    const id = workflowId();
    if (!id) return;
    openPage({
      workflowId: id,
      page: {
        kind: "version",
        versionId: version.id,
        version: version.version,
        current: version.isCurrent,
        status: "loading",
        payload: null,
      },
    });
    compare.mutateAsync({ workflowId: id, versionId: version.id }).then(
      (payload) =>
        settleVersion({ workflowId: id, versionId: version.id, payload }),
      // The mutation's metadata reports the failure; the page says it too.
      () =>
        settleVersion({ workflowId: id, versionId: version.id, payload: null })
    );
  };

  const back = () => {
    const id = workflowId();
    if (id) closePage(id);
    setHighlight(null);
  };

  const close = () => {
    const id = workflowId();
    if (!id) return;
    clearPages(id);
    clearPublicationReview(id);
    setHighlight(null);
  };

  const restoreVersionOptions =
    orpcQuery.workflow.restoreVersion.mutationOptions();
  const restoreMutation = useMutation({
    ...restoreVersionOptions,
    // The restore is pinned to the draft revision the save below records, so
    // edits still waiting for autosave are saved first and nothing is lost.
    mutationFn: async (input, context) => {
      const saved = await saveWorkflow(
        { nodes: store.get(nodesAtom), edges: store.get(edgesAtom) },
        { immediate: true }
      );
      if (!saved?.ok) {
        throw saved?.error ?? new Error("Unable to save the current draft");
      }
      return await restoreVersionOptions.mutationFn!(
        { ...input, expectedDraftRevision: saved.workflow.draftRevision },
        context
      );
    },
    onSuccess: async (payload, variables) => {
      cacheWorkflow(queryClient, payload);
      await refreshWorkflowList(queryClient);
      if (
        installRestoredWorkflow({
          expectedWorkflowId: variables.workflowId,
          workflow: toSavedWorkflow(payload),
        })
      ) {
        clearPages(variables.workflowId);
        clearPublicationReview(variables.workflowId);
        setHighlight(null);
        toast.success("Version restored as draft");
      }
    },
    meta: { errorMessage: "Unable to restore this version as a draft" },
  });

  const restore = (versionId: string) => {
    const id = workflowId();
    if (id && canRestore) {
      restoreMutation.mutate({
        workflowId: id,
        versionId,
        expectedDraftRevision: store.get(currentWorkflowDraftRevisionAtom),
      });
    }
  };

  const showOnCanvas = (nodeId: string) => {
    const node = store.get(displayNodesAtom).find((item) => item.id === nodeId);
    if (!node) return;
    // A step in a Group the viewer collapsed draws its Group in place again,
    // so the step has a card to place.
    if (node.parentId !== undefined) {
      store.set(expandGroupAtom, node.parentId);
    }
    setHighlight(nodeId);
    requestPlacement({
      addressId: workspaceAddressId(store.get(activeWorkspaceAddressAtom)),
      nodeIds: [nodeId],
    });
  };

  return {
    canReadHistory,
    canRestore,
    openHistory,
    openVersion,
    back,
    close,
    restore,
    isRestoring: restoreMutation.isPending,
    showOnCanvas,
  };
}
