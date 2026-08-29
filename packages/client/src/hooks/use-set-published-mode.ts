/**
 * The one place that changes a workflow's Published mode. Switching to Test
 * writes on a single press, because it can only narrow who a run reaches.
 * Switching to Live confirms first: the status strip, the Actions menu and the
 * command palette all call this hook, so no surface turns on real sending
 * silently. The write uses the save queue, then refreshes the workflow list.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import {
  orpcQuery,
  refreshWorkflowList,
  selectPublicationState,
} from "#src/lib/rpc-query";
import type { WorkflowMode } from "#src/lib/workflow-graph-types";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  currentWorkflowNameAtom,
  setWorkflowModeAtom,
} from "#src/lib/workflow-save-store";

/**
 * Names the version the mode governs, for the confirmation message. Before the
 * first publish there is no number, so the phrase stays generic.
 */
function publishedVersionPhrase(publishedVersion: number | undefined): string {
  return publishedVersion === undefined
    ? "the published version"
    : `Published v${publishedVersion}`;
}

export function useSetPublishedMode(): (mode: WorkflowMode) => Promise<void> {
  const { push } = useOverlay();
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const workflowName = useAtomValue(currentWorkflowNameAtom);
  const [workflowMode, setCurrentWorkflowMode] = useAtom(
    currentWorkflowModeAtom
  );
  const setWorkflowMode = useSetAtom(setWorkflowModeAtom);
  const queryClient = useQueryClient();

  const write = useCallback(
    async (mode: WorkflowMode) => {
      const outcome = await setWorkflowMode(mode);
      if (!outcome?.ok) {
        toast.error("Failed to update workflow mode");
        return;
      }

      setCurrentWorkflowMode(outcome.workflow.mode);
      // The dashboard's "Sends to" cell is the one place that says whether real
      // people get messaged, and that table can be mounted while this write
      // lands. The save queue only marks the list stale, which refetches
      // nothing under an active observer, so refetch the list here.
      await refreshWorkflowList(queryClient);
      toast.success(
        mode === "test"
          ? "Published mode set to Test"
          : "Published mode set to Live"
      );
    },
    [queryClient, setCurrentWorkflowMode, setWorkflowMode]
  );

  return useCallback(
    async (mode: WorkflowMode) => {
      if (!workflowId || workflowMode === mode) {
        return;
      }

      if (mode === "test") {
        await write("test");
        return;
      }

      // A one-off read, because the version is needed only at the press. This
      // cache entry is the one the status strip already observes: the route
      // loader seeds it and every publish patches it.
      const cached = queryClient.getQueryData(
        orpcQuery.workflow.getById.queryKey({ input: { workflowId } })
      );

      push(ConfirmOverlay, {
        title: `Send real messages from ${workflowName || "this workflow"}?`,
        message: `Events and manual runs of ${publishedVersionPhrase(
          cached ? selectPublicationState(cached).publishedVersion : undefined
        )} will reach real recipients.`,
        confirmLabel: "Send real messages",
        destructive: true,
        onConfirm: () => write("live"),
      });
    },
    [queryClient, push, workflowId, workflowMode, workflowName, write]
  );
}
