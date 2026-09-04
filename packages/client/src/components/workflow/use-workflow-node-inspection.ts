import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  activeComparisonAtom,
  setComparisonSubviewAtom,
} from "#src/lib/workflow-comparison-store";
import {
  isExecutionOverlayActiveAtom,
  selectOnlyNodeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";

/** Select a displayed node and reveal the inspector appropriate to its workspace. */
export function useWorkflowNodeInspection(): (nodeId: string) => void {
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);
  const overlayActive = useAtomValue(isExecutionOverlayActiveAtom);
  const comparisonActive = useAtomValue(activeComparisonAtom) !== null;
  const workspaceView = useAtomValue(workflowWorkspaceViewAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const setComparisonSubview = useSetAtom(setComparisonSubviewAtom);
  const isMobile = useIsMobile();
  const { openSheet } = useConfigurationSheet();

  return useCallback(
    (nodeId) => {
      const isRunsOverlay = workspaceView === "runs" && overlayActive;
      const isResolvedReadOnlyPresentation =
        isRunsOverlay || (workspaceView === "changes" && comparisonActive);
      if (isResolvedReadOnlyPresentation) {
        selectOnlyNode(nodeId);
      } else {
        setSelectedNode(nodeId);
      }
      if (isRunsOverlay) {
        return;
      }
      if (comparisonActive && currentWorkflowId) {
        setComparisonSubview({
          workflowId: currentWorkflowId,
          subview: "properties",
        });
      }
      if (isMobile) {
        openSheet();
      }
    },
    [
      comparisonActive,
      currentWorkflowId,
      isMobile,
      openSheet,
      overlayActive,
      selectOnlyNode,
      setComparisonSubview,
      setSelectedNode,
      workspaceView,
    ]
  );
}
