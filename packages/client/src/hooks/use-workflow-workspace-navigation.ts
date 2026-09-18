import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useStore } from "jotai";
import { useCallback } from "react";
import { useRevealNavigation } from "#src/components/workflow/canvas-reveal/use-reveal-navigation";
import { comparisonSessionAtom } from "#src/lib/workflow-comparison-store";
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

type OpenComparison = (options: {
  current?: boolean;
  force?: boolean;
}) => Promise<void>;

export type WorkflowWorkspaceNavigation = {
  showDraft: () => void;
  showRuns: () => void;
  showChanges: () => void;
};

/**
 * Switches Draft, Runs, and Changes by navigating to the route search the
 * target view last showed, so each view comes back as it was left. Each switch
 * pushes a history entry, so Back returns to the workspace left. The Reveal
 * navigation decides whether the switch opens the inspector.
 */
export function useWorkflowWorkspaceNavigation(
  openComparison?: OpenComparison
): WorkflowWorkspaceNavigation {
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const store = useStore();
  const navigation = useRevealNavigation();
  const workspaceView = useAtomValue(workflowWorkspaceViewAtom);

  /** Open the inspector of the active address, without the cookie. */
  const openInspector = useCallback(
    () => navigation.openInspector(store.get(activeWorkspaceAddressAtom)),
    [navigation, store]
  );

  // The route has not synced the search just navigated to, so the address is
  // read from the search itself.
  const switchTo = useCallback(
    (view: WorkspaceView, search?: WorkflowRouteSearch) => {
      const remembered = store.get(rememberedRouteSearchesAtom)[view];
      const target = search ?? remembered ?? (view === "draft" ? {} : { view });
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
      openInspector();
      return;
    }
    switchTo("runs");
  }, [openInspector, switchTo, workspaceView]);

  const showChanges = useCallback(() => {
    if (workspaceView === "changes") {
      openInspector();
      return;
    }
    const session = store.get(comparisonSessionAtom);
    if (!session) {
      // The Changes route opens its comparison once it is applied.
      switchTo("changes");
      return;
    }
    // A comparison chosen while its base was the current publication follows
    // the current publication, which a publish since then has replaced. A
    // comparison against an older version refreshes against that version. The
    // request starts first, so route recovery sees it pending.
    const base = session.payload.baseVersion;
    if (base === null || base.isCurrent) {
      void openComparison?.({ current: true });
      // The rest of the search Changes last showed, such as its focused Group,
      // stays in the route, and route recovery removes a Group the new
      // comparison does not hold.
      const { compare: _compare, ...remembered } =
        store.get(rememberedRouteSearchesAtom).changes ?? {};
      switchTo("changes", { ...remembered, view: "changes" });
    } else {
      void openComparison?.({ force: true });
      switchTo("changes");
    }
  }, [openComparison, openInspector, store, switchTo, workspaceView]);

  return { showDraft, showRuns, showChanges };
}
