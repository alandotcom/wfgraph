/**
 * The one place that changes a workflow's Published mode. The status strip is
 * the only surface that calls this hook. A switch in either direction takes
 * one press: the mode is a setting the strip states at all times, and it
 * sends nothing on its own. The write uses the save queue, then refreshes the
 * workflow list.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { toast } from "sonner";
import { refreshWorkflowList } from "#src/lib/rpc-query";
import type { WorkflowMode } from "#src/lib/workflow-graph-types";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  setWorkflowModeAtom,
} from "#src/lib/workflow-save-store";

export function useSetPublishedMode(): (mode: WorkflowMode) => Promise<void> {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const [workflowMode, setCurrentWorkflowMode] = useAtom(
    currentWorkflowModeAtom
  );
  const setWorkflowMode = useSetAtom(setWorkflowModeAtom);
  const queryClient = useQueryClient();

  return useCallback(
    async (mode: WorkflowMode) => {
      // An unsaved canvas has no workflow to write the setting to, and a mode
      // already set is not a change.
      if (!workflowId || workflowMode === mode) {
        return;
      }

      const outcome = await setWorkflowMode(mode);
      if (!outcome?.ok) {
        toast.error("Failed to set Published mode");
        return;
      }

      setCurrentWorkflowMode(outcome.workflow.mode);
      // The dashboard's Published mode cell shows this setting, and that
      // table can be mounted while this write lands. The save queue only
      // marks the list stale, which refetches nothing under an active
      // observer, so refetch the list here.
      await refreshWorkflowList(queryClient);
      toast.success(
        mode === "test"
          ? "Published mode set to Test"
          : "Published mode set to Live"
      );
    },
    [
      queryClient,
      setCurrentWorkflowMode,
      setWorkflowMode,
      workflowId,
      workflowMode,
    ]
  );
}
