import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useStore } from "jotai";
import { useCallback } from "react";
import { useRevealNavigation } from "#src/components/workflow/canvas-reveal/use-reveal-navigation";
import {
  workspaceAddressFromSearch,
  type WorkflowRouteSearch,
  type WorkspaceView,
} from "#src/lib/workflow-navigation-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import {
  activeWorkspaceAddressAtom,
  rememberedRouteSearchesAtom,
} from "#src/lib/workflow-workspace-navigation";

export type WorkflowWorkspaceNavigation = {
  showDraft: () => void;
  showRuns: () => void;
};

/**
 * Switches Draft and Runs by navigating to the route search the target view
 * last showed, so each view comes back as it was left. Each switch pushes a
 * history entry, so Back returns to the workspace left. The Reveal navigation
 * decides whether the switch opens the inspector.
 */
export function useWorkflowWorkspaceNavigation(): WorkflowWorkspaceNavigation {
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const store = useStore();
  const navigation = useRevealNavigation();
  const workspaceView = useAtomValue(workflowWorkspaceViewAtom);

  // The route has not synced the search just navigated to, so the address is
  // read from the search itself.
  const switchTo = useCallback(
    (view: WorkspaceView) => {
      const remembered = store.get(rememberedRouteSearchesAtom)[view];
      const target: WorkflowRouteSearch =
        remembered ?? (view === "draft" ? {} : { view });
      void navigate({ search: target });
      if (view !== "draft") {
        navigation.showSwitchedWorkspace({
          address: workspaceAddressFromSearch(
            store.get(currentWorkflowIdAtom) ?? "",
            target
          ),
          firstVisit: remembered === undefined,
        });
      }
    },
    [navigate, navigation, store]
  );

  const showDraft = useCallback(() => switchTo("draft"), [switchTo]);

  const showRuns = useCallback(() => {
    if (workspaceView === "runs") {
      navigation.openInspector(store.get(activeWorkspaceAddressAtom));
      return;
    }
    switchTo("runs");
  }, [navigation, store, switchTo, workspaceView]);

  return { showDraft, showRuns };
}
