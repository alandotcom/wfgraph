import { useAtomValueRawSync, useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import {
  displayNodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { workspaceAddressId } from "#src/lib/workflow-navigation-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import { expandGroupAtom } from "#src/lib/collapsed-groups";
import { requestRevealPlacementAtom } from "./canvas-reveal/reveal-requests";
import { useWorkflowNodeInspection } from "./use-workflow-node-inspection";

/**
 * Select a node, open its inspector, and ask the canvas camera to show it when
 * it is not in view. Every step is on the one canvas; a step inside a Group
 * the viewer collapsed draws that Group in place first, so the step has a
 * card to show. The zoom is kept unless the node needs less to fit, and no
 * graph data changes.
 */
export function useFocusWorkflowNode(): (input: {
  nodeId: string;
  workflowId: string;
}) => boolean {
  // Draft and route synchronizers can write these before subscriptions mount.
  const nodes = useAtomValueRawSync(displayNodesAtom);
  const workflowId = useAtomValueRawSync(currentWorkflowIdAtom);
  const inspectNode = useWorkflowNodeInspection();
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  const expandGroup = useSetAtom(expandGroupAtom);
  const store = useStore();
  return useCallback(
    (input) => {
      if (workflowId !== input.workflowId) {
        return false;
      }
      const node = nodes.find((item) => item.id === input.nodeId);
      if (!node) {
        return false;
      }
      if (node.parentId !== undefined) {
        expandGroup(node.parentId);
      }
      selectOnlyNode(input.nodeId);
      inspectNode(input.nodeId);
      requestPlacement({
        addressId: workspaceAddressId(store.get(activeWorkspaceAddressAtom)),
        nodeIds: [input.nodeId],
      });
      return true;
    },
    [
      expandGroup,
      inspectNode,
      nodes,
      requestPlacement,
      selectOnlyNode,
      store,
      workflowId,
    ]
  );
}
