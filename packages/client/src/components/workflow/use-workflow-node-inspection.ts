import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  activeComparisonAtom,
  setComparisonSubviewAtom,
} from "#src/lib/workflow-comparison-store";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import {
  clearSelectionAtom,
  executionOverlayGraphAtom,
  isExecutionOverlayActiveAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  revealFollowsSelection,
  selectedObject,
  workspaceAddressId,
} from "#src/lib/workflow-navigation-state";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  clearRunNodeInspectionAtom,
  inspectRunNodeAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  canvasRevealAtom,
  reopenCanvasRevealAtom,
} from "./canvas-reveal/canvas-reveal-state";
import { runEvidenceOriginAtom } from "./use-run-node-evidence";

/**
 * Select a displayed node and reveal the inspector appropriate to its
 * workspace. In a workspace whose Canvas Reveal follows the selection,
 * selecting the node that is already the sole selection reopens a closed
 * Canvas Reveal at its saved level. On a run's canvas on desktop, selecting a
 * node opens Canvas Reveal at Focus on its evidence, and a Group frame, which
 * has none, is only selected. That opening writes no Reveal preference, and an
 * opening from a closed Reveal is recorded so Back closes Reveal again. The
 * `selectionApplied` option skips the selection write when React Flow's own
 * `select` handling already applied it, such as a click on the editable Draft
 * canvas where a modifier click adds to a multi-selection instead of replacing
 * it.
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
      if (isRunsOverlay) {
        const address = store.get(activeWorkspaceAddressAtom);
        const node = store
          .get(executionOverlayGraphAtom)
          ?.nodes.find((item) => item.id === nodeId);
        const opensFocus = !isMobile && !isGroupNode(node);
        const reveal = store.get(canvasRevealAtom);
        store.set(runEvidenceOriginAtom, {
          addressId: workspaceAddressId(address),
          nodeId,
          logId: null,
          closedReopenLevel:
            opensFocus && reveal.level === "closed"
              ? reveal.presentation.reopenLevel
              : null,
        });
        store.set(inspectRunNodeAtom, {
          address,
          nodeId,
          executionLogId: null,
          selectsNode: true,
          opensFocus,
        });
        return;
      }
      if (!options?.selectionApplied) {
        selectOnlyNode(nodeId);
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

/**
 * Clear what a click on the empty canvas pane dismisses. On a run's canvas that
 * is the node inspection, which also drops a chosen execution of a node nothing
 * selects; elsewhere it is the selection.
 */
export function useClearWorkflowNodeInspection(): () => void {
  const overlayActive = useAtomValue(isExecutionOverlayActiveAtom);
  const workspaceView = useAtomValue(workflowWorkspaceViewAtom);
  const clearSelection = useSetAtom(clearSelectionAtom);
  const clearRunNodeInspection = useSetAtom(clearRunNodeInspectionAtom);
  return workspaceView === "runs" && overlayActive
    ? clearRunNodeInspection
    : clearSelection;
}
