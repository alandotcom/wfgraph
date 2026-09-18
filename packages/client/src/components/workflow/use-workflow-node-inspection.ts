import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import {
  clearSelectionAtom,
  executionOverlayGraphAtom,
  isExecutionOverlayActiveAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import {
  activeWorkspaceAddressAtom,
  clearRunNodeInspectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { useRevealNavigation } from "./canvas-reveal/use-reveal-navigation";

/**
 * Select a displayed node and reveal the inspector for its workspace and form
 * factor. On a run's canvas a step shows its evidence and a Group frame, which
 * has no evidence, shows its run summary, through
 * `RevealNavigation.pressRunCanvasNode`. Anywhere else the node is selected and
 * `RevealNavigation.showPressedNode` shows it. The `selectionApplied` option
 * skips the selection write when React Flow's own `select` handling already
 * applied it, such as a click on the editable Draft canvas where a modifier
 * click adds to a multi-selection instead of replacing it.
 */
export function useWorkflowNodeInspection(): (
  nodeId: string,
  options?: { selectionApplied?: boolean }
) => void {
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);
  const overlayActive = useAtomValue(isExecutionOverlayActiveAtom);
  const workspaceView = useAtomValue(workflowWorkspaceViewAtom);
  const navigation = useRevealNavigation();
  const store = useStore();

  return useCallback(
    (nodeId, options) => {
      const address = store.get(activeWorkspaceAddressAtom);
      if (workspaceView === "runs" && overlayActive) {
        const node = store
          .get(executionOverlayGraphAtom)
          ?.nodes.find((item) => item.id === nodeId);
        navigation.pressRunCanvasNode({
          address,
          nodeId,
          isGroup: isGroupNode(node),
        });
        return;
      }
      if (!options?.selectionApplied) {
        selectOnlyNode(nodeId);
      }
      navigation.showPressedNode({ address, nodeId });
    },
    [navigation, overlayActive, selectOnlyNode, store, workspaceView]
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
