import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { notifications as toast } from "#src/lib/notifications";
import {
  orpcQuery,
  refreshRunHistory,
  refreshWorkflowList,
} from "#src/lib/rpc-query";

/**
 * Delete the workflow the editor is on, then leave for the dashboard.
 *
 * Shared by the toolbar menu and the configuration overlay, which is the point:
 * a call site that invalidated the list itself could forget to, and the
 * dashboard would then read its 30-second-fresh cache and keep painting the
 * workflow the user had just deleted.
 *
 * The refresh is awaited before navigating. The toolbar holds an observer on the
 * workflow list, so it resolves against a live refetch and the dashboard mounts
 * on data that no longer has the deleted row.
 */
export function useDeleteWorkflow() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation(
    orpcQuery.workflow.delete.mutationOptions({
      onSuccess: async () => {
        toast.success("Workflow deleted successfully");
        // The runs cascade with the workflow, so the dashboard's run history is
        // wrong too.
        await Promise.all([
          refreshWorkflowList(queryClient),
          refreshRunHistory(queryClient),
        ]);
        await navigate({ to: "/", replace: true });
      },
      meta: { errorMessage: "Failed to delete workflow. Please try again." },
    })
  );
}
