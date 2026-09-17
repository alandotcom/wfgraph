import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useStore } from "jotai";
import { useCallback } from "react";
import { useRevealNavigation } from "#src/components/workflow/canvas-reveal/use-reveal-navigation";
import { useIsMobile } from "#src/hooks/use-mobile";
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
 * pushes a history entry, so Back returns to the workspace left. The inspector
 * opens on a view's first visit, and on mobile, where the sheet is not
 * remembered.
 */
export function useWorkflowWorkspaceNavigation(
  openComparison?: OpenComparison
): WorkflowWorkspaceNavigation {
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const store = useStore();
  const isMobile = useIsMobile();
  const navigation = useRevealNavigation();
  const workspaceView = useAtomValue(workflowWorkspaceViewAtom);

  /**
   * Open the inspector for the address a search names, or the active address
   * for null, without the cookie. The route has not synced a named search yet,
   * so the address is read from the search itself.
   */
  const openInspector = useCallback(
    (search: WorkflowRouteSearch | null) => {
      navigation.openInspector(
        search === null
          ? store.get(activeWorkspaceAddressAtom)
          : workspaceAddressFromSearch(
              store.get(currentWorkflowIdAtom) ?? "",
              search
            )
      );
    },
    [navigation, store]
  );

  const switchTo = useCallback(
    (view: WorkspaceView, search?: WorkflowRouteSearch) => {
      const remembered = store.get(rememberedRouteSearchesAtom)[view];
      const target = search ?? remembered ?? (view === "draft" ? {} : { view });
      void navigate({ search: target });
      if (view !== "draft" && (isMobile || remembered === undefined)) {
        openInspector(target);
      }
    },
    [isMobile, navigate, openInspector, store]
  );

  const showDraft = useCallback(() => switchTo("draft"), [switchTo]);

  const showRuns = useCallback(() => {
    if (workspaceView === "runs") {
      openInspector(null);
      return;
    }
    switchTo("runs");
  }, [openInspector, switchTo, workspaceView]);

  const showChanges = useCallback(() => {
    if (workspaceView === "changes") {
      openInspector(null);
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
