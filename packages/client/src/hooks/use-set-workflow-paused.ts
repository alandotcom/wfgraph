/**
 * Pauses or resumes the open workflow, for the editor's surfaces that offer
 * it: the status strip's Resume button, the workflow menu and the command
 * palette. A pause
 * refuses every new run, Event, schedule and manual alike, and leaves the runs
 * already in flight alone (CONTEXT.md, "Paused workflow").
 *
 * The write is the workflows page's bulk lifecycle procedure with one id. On
 * success it re-reads the open workflow's entry, which the strip and the run
 * controls read `isPaused` from, and the workflow list.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getClientLogger } from "#src/lib/logger";
import {
  orpcQuery,
  refreshWorkflowList,
  refreshWorkflowPublication,
} from "#src/lib/rpc-query";

const logger = getClientLogger("workflows");

export function useSetWorkflowPaused(workflowId: string | null | undefined): {
  setPaused: (paused: boolean) => void;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation(
    orpcQuery.workflow.bulkLifecycle.mutationOptions({
      onSuccess: async (result, { action, workflowIds }) => {
        if (result.summary.failed > 0) {
          toast.error(
            action === "pause"
              ? "Could not pause the workflow."
              : "Could not resume the workflow."
          );
        } else {
          toast.success(
            action === "pause" ? "Workflow paused" : "Workflow resumed"
          );
        }
        await Promise.all([
          refreshWorkflowList(queryClient),
          ...workflowIds.map((id) =>
            refreshWorkflowPublication(queryClient, id)
          ),
        ]);
      },
      // The sentence names the action, which the cache's own handler cannot
      // see, so this mutation shows every failure itself.
      onError: (error, { action }) => {
        logger.error(`Failed to ${action} workflow`, { action, error });
        toast.error(
          action === "pause"
            ? "Could not pause the workflow."
            : "Could not resume the workflow."
        );
      },
      meta: { errorShownByCaller: true },
    })
  );

  const { mutate, isPending } = mutation;
  return {
    setPaused: (paused: boolean) => {
      if (!workflowId) {
        return;
      }
      mutate({
        workflowIds: [workflowId],
        action: paused ? "pause" : "resume",
      });
    },
    isPending,
  };
}
