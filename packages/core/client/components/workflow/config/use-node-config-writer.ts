import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { repairNodeIntegration } from "@/lib/node-integration";
import { integrationsQueryOptions, orpcQuery } from "@/lib/rpc-query";
import { seedConditionModel } from "@/lib/seed-condition-model";
import {
  edgesAtom,
  nodesAtom,
  selectedNodeAtom,
  updateNodeDataAtom,
} from "@/lib/workflow-graph-store";
import type { NodeConfigPatch } from "./node-config-patch";

/**
 * Writing a config change to the selected node, with everything that has to
 * settle at the same moment.
 *
 * Shared by the two places a node is configured, the sidebar panel and the
 * configuration overlay, which are near-duplicates of each other. They had
 * drifted apart here: the overlay never cleared a stale connection when the
 * action changed, and never repaired one.
 */
export function useNodeConfigWriter() {
  const store = useStore();
  const queryClient = useQueryClient();
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const { data: integrations = [] } = useQuery(integrationsQueryOptions());

  const updateConfig = useCallback(
    (patch: NodeConfigPatch) => {
      // Read the node as the store has it right now, so a write that lands
      // while an earlier render is still in scope cannot carry stale keys back.
      const latestNodes = store.get(nodesAtom);
      const latestNode = latestNodes.find((node) => node.id === selectedNodeId);
      if (!latestNode) {
        return;
      }

      // Picking a different action invalidates whatever connection the previous
      // action was bound to, so the two keys move together.
      const isActionTypeUpdate = typeof patch.actionType === "string";
      const shouldClearIntegration =
        isActionTypeUpdate && Boolean(latestNode.data.config?.integrationId);

      const newConfig: Record<string, unknown> = {
        ...latestNode.data.config,
        ...patch,
        ...(shouldClearIntegration ? { integrationId: undefined } : {}),
      };

      // A Condition node has to arrive with a model, because the engine rejects
      // one without it. The action being chosen is the moment that gap opens.
      if (patch.actionType === "Condition" && !newConfig.conditionModel) {
        Object.assign(
          newConfig,
          seedConditionModel({
            nodeId: latestNode.id,
            nodes: latestNodes,
            edges: store.get(edgesAtom),
          })
        );
      }

      // Choosing an action is exactly when its connection can be settled, and
      // the connection list is already in hand. This used to be a fetch with an
      // abort controller and a "pending" flag to hide the warning that flashed
      // while it was in flight; with the list cached there is no flight and no
      // flash.
      const repaired = repairNodeIntegration(
        { ...latestNode, data: { ...latestNode.data, config: newConfig } },
        integrations
      );

      updateNodeData({
        id: latestNode.id,
        data: { config: repaired.data.config },
      });
    },
    [store, selectedNodeId, integrations, updateNodeData]
  );

  /** Re-read the run list. Both panels put a Refresh button above it. */
  const refreshRuns = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: orpcQuery.workflow.getExecutions.key(),
      }),
    [queryClient]
  );

  return { updateConfig, refreshRuns };
}
