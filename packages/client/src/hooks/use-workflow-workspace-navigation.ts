import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  isSidebarCollapsedAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import {
  enterChangesWorkspaceAtom,
  enterDraftWorkspaceAtom,
  enterRunsWorkspaceAtom,
} from "#src/lib/workflow-workspace-navigation";

type OpenComparison = (options: { fresh: true }) => Promise<void>;

export type WorkflowWorkspaceNavigation = {
  showDraft: () => void;
  showRuns: () => void;
  showChanges: () => void;
};

/** Coordinates workspace state, route state, and inspector visibility. */
export function useWorkflowWorkspaceNavigation(
  openComparison?: OpenComparison
): WorkflowWorkspaceNavigation {
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const isMobile = useIsMobile();
  const { openSheet } = useConfigurationSheet();
  const workspaceView = useAtomValue(workflowWorkspaceViewAtom);
  const setSidebarCollapsed = useSetAtom(isSidebarCollapsedAtom);
  const enterDraft = useSetAtom(enterDraftWorkspaceAtom);
  const enterRuns = useSetAtom(enterRunsWorkspaceAtom);
  const enterChanges = useSetAtom(enterChangesWorkspaceAtom);

  const openInspector = useCallback(() => {
    if (isMobile) {
      openSheet();
    } else {
      setSidebarCollapsed(false);
    }
  }, [isMobile, openSheet, setSidebarCollapsed]);

  const showDraft = useCallback(() => {
    enterDraft();
    void navigate({ search: {}, replace: true });
  }, [enterDraft, navigate]);

  const showRuns = useCallback(() => {
    if (workspaceView !== "runs") {
      enterRuns();
    }
    openInspector();
  }, [enterRuns, openInspector, workspaceView]);

  const showChanges = useCallback(() => {
    if (workspaceView === "changes") {
      openInspector();
      return;
    }
    void (async () => {
      // Clearing a run search re-runs the workflow loader, which restores the
      // route's default Draft workspace. Enter Changes only after that loader
      // has settled so the route cannot overwrite this transition.
      if (workspaceView === "runs") {
        await navigate({ search: {}, replace: true });
      }
      enterChanges();
      openInspector();
      await openComparison?.({ fresh: true });
    })();
  }, [enterChanges, navigate, openComparison, openInspector, workspaceView]);

  return { showDraft, showRuns, showChanges };
}
