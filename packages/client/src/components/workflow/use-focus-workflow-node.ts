import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import {
  displayNodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { workspaceAddressId } from "#src/lib/workflow-navigation-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import { requestRevealPlacementAtom } from "./canvas-reveal/reveal-requests";
import { useWorkflowNodeInspection } from "./use-workflow-node-inspection";

/**
 * Select a displayed node, open its inspector, and ask the canvas camera to
 * place it beside Canvas Reveal in the active address. The zoom is kept unless
 * the node needs less to fit, and no graph data changes.
 */
export function useFocusWorkflowNode(): (input: {
  nodeId: string;
  workflowId: string;
}) => boolean {
  const nodes = useAtomValue(displayNodesAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const inspectNode = useWorkflowNodeInspection();
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  const store = useStore();
  return useCallback(
    (input) => {
      if (workflowId !== input.workflowId) {
        return false;
      }
      if (!nodes.some((item) => item.id === input.nodeId)) {
        return false;
      }
      selectOnlyNode(input.nodeId);
      inspectNode(input.nodeId);
      requestPlacement({
        addressId: workspaceAddressId(store.get(activeWorkspaceAddressAtom)),
        nodeIds: [input.nodeId],
      });
      return true;
    },
    [inspectNode, nodes, requestPlacement, selectOnlyNode, store, workflowId]
  );
}
