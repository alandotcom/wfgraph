import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  displayNodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  scopeId,
  scopeOfNode,
  workspaceAddressId,
  workspaceRouteSearch,
} from "#src/lib/workflow-navigation-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  activeWorkspaceAddressAtom,
  setWorkspaceSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { requestRevealPlacementAtom } from "./canvas-reveal/reveal-requests";
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
  const nodes = useAtomValue(displayNodesAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const inspectNode = useWorkflowNodeInspection();
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);
  const setWorkspaceSelection = useSetAtom(setWorkspaceSelectionAtom);
  const requestPlacement = useSetAtom(requestRevealPlacementAtom);
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const isMobile = useIsMobile();
  const { openSheet } = useConfigurationSheet();
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
      void navigate({ search: workspaceRouteSearch(target) });
      if (isMobile) {
        openSheet();
      }
      return true;
    },
    [
      inspectNode,
      isMobile,
      navigate,
      nodes,
      openSheet,
      requestPlacement,
      selectOnlyNode,
      setWorkspaceSelection,
      store,
      workflowId,
    ]
  );
}
