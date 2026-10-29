import type { Store } from "jotai";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { applyWorkspaceRouteAtom } from "#src/lib/workflow-workspace-navigation";

/**
 * Apply an editor route search to a test store, as `WorkspaceRouteSync` does
 * for the router. The route names the open workflow unless `workflowId` is
 * given, so set `currentWorkflowIdAtom` first.
 */
export function showWorkspaceRoute(
  store: Store,
  search: WorkflowRouteSearch,
  workflowId?: string
): void {
  store.set(applyWorkspaceRouteAtom, {
    workflowId: workflowId ?? store.get(currentWorkflowIdAtom) ?? "",
    search,
  });
}
