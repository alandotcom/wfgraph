import { useAtomValue, useSetAtom, useStore } from "jotai";
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
import {
  revealFollowsSelection,
  selectedObject,
} from "#src/lib/workflow-navigation-state";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { reopenCanvasRevealAtom } from "./canvas-reveal/canvas-reveal-state";

/**
 * Select a displayed node and reveal the inspector appropriate to its
 * workspace. In a workspace whose Canvas Reveal follows the selection,
 * selecting the node that is already the sole selection reopens a closed
 * Canvas Reveal at its saved level. The `selectionApplied`
 * option skips the selection write when React Flow's own `select` handling
 * already applied it, such as a click on the editable Draft canvas where a
 * modifier click adds to a multi-selection instead of replacing it.
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
  const store = useStore();
  const reopenCanvasReveal = useSetAtom(reopenCanvasRevealAtom);

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
      } else if (
        revealFollowsSelection(workspaceView) &&
        selectedObject(store.get(activeSelectionAtom))?.id === nodeId
      ) {
        reopenCanvasReveal();
      }
    },
    [
      comparisonActive,
      currentWorkflowId,
      isMobile,
      openSheet,
      overlayActive,
      reopenCanvasReveal,
      selectOnlyNode,
      setComparisonSubview,
      store,
      workspaceView,
    ]
  );
}
