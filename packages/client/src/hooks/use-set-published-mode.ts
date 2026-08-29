/**
 * Published mode, changed from one place.
 *
 * The change has two shapes. Test-ward is a single click, since it can only
 * narrow who a run reaches. Live-ward asks first, because it is the moment a
 * workflow starts sending to real people, and it must ask wherever it is
 * offered: the status strip's control, the Actions menu and the command
 * palette all reach the setting through this hook, so none of them can be the
 * surface that changes it silently.
 *
 * The write goes through the editor's save queue, on the workflow the save
 * store's atoms name. A success refreshes the workflow list, because the
 * dashboard offers this setting while showing what it answers.
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
 * The version the mode governs, as the confirmation names it. Before the first
 * publish there is no number to give, and the setting is waiting for one.
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
      // The dashboard offers this setting on a row whose "Sends to" cell is the
      // one place saying whether real people get messaged, and that table is
      // mounted while the write lands. The save queue only marks the list
      // stale, which refetches nothing under an active observer, so the
      // deliberate change refetches the list itself.
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

      // Read rather than observed: the version is wanted once, at the press,
      // and this entry is the one the status strip is already watching, seeded
      // by the route loader and patched by every publish.
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
