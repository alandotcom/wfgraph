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
} from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";

/**
 * Select a displayed node and reveal the inspector appropriate to its
 * workspace. `selectionApplied` says React Flow's own `select` changes have
 * already written the selection, as for a click on the editable Draft canvas,
 * where a modifier click adds to a multi-selection this must not replace.
 */
export function useWorkflowNodeInspection(): (
  nodeId: string,
  options?: { selectionApplied?: boolean }
) => void {
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);
  const overlayActive = useAtomValue(isExecutionOverlayActiveAtom);
  const comparisonActive = useAtomValue(activeComparisonAtom) !== null;
  const workspaceView = useAtomValue(workflowWorkspaceViewAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const setComparisonSubview = useSetAtom(setComparisonSubviewAtom);
  const isMobile = useIsMobile();
  const { openSheet } = useConfigurationSheet();

  return useCallback(
    (nodeId, options) => {
      const isRunsOverlay = workspaceView === "runs" && overlayActive;
      if (!options?.selectionApplied) {
        selectOnlyNode(nodeId);
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
      workspaceView,
    ]
  );
}
