import { useNavigate } from "@tanstack/react-router";
import { useAtomValueRawSync, useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import {
  displayNodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { scopeOfNode } from "#src/lib/workflow-scope-graph";
import {
  scopeId,
  workspaceAddressId,
  workspaceRouteSearch,
} from "#src/lib/workflow-navigation-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  activeWorkspaceAddressAtom,
  setWorkspaceSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { requestRevealPlacementAtom } from "./canvas-reveal/reveal-requests";
import { useRevealNavigation } from "./canvas-reveal/use-reveal-navigation";
import { useWorkflowNodeInspection } from "./use-workflow-node-inspection";

/**
 * Select a node, open its inspector, and ask the canvas camera to place it
 * beside Canvas Reveal. A Group member is shown on its focused Group canvas and
 * any other node on the overview, so reaching a node in the other scope pushes
 * that scope's route and selects the node there. The zoom is kept unless the
 * node needs less to fit, and no graph data changes.
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
  const setWorkspaceSelection = useSetAtom(setWorkspaceSelectionAtom);
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const navigation = useRevealNavigation();
  const store = useStore();
  return useCallback(
    (input) => {
      if (workflowId !== input.workflowId) {
        return false;
      }
      if (!nodes.some((item) => item.id === input.nodeId)) {
        return false;
      }
      const scope = scopeOfNode(nodes, input.nodeId);
      const active = store.get(activeWorkspaceAddressAtom);
      if (scopeId(scope) === scopeId(active.scope)) {
        selectOnlyNode(input.nodeId);
        inspectNode(input.nodeId);
        requestPlacement({
          addressId: workspaceAddressId(active),
          nodeIds: [input.nodeId],
        });
        return true;
      }
      const target = { ...active, scope };
      setWorkspaceSelection({
        address: target,
        selection: { nodeIds: [input.nodeId], edgeIds: [] },
      });
      requestPlacement({
        addressId: workspaceAddressId(target),
        nodeIds: [input.nodeId],
      });
      navigation.showPressedNode({ address: target, nodeId: input.nodeId });
      void navigate({ search: workspaceRouteSearch(target) });
      return true;
    },
    [
      inspectNode,
      navigate,
      navigation,
      nodes,
      requestPlacement,
      selectOnlyNode,
      setWorkspaceSelection,
      store,
      workflowId,
    ]
  );
}
