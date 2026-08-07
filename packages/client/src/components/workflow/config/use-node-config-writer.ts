import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { toast } from "sonner";
import { repairNodeIntegration } from "#src/lib/node-integration";
import {
  integrationsQueryOptions,
  orpcQuery,
  refreshRunHistory,
} from "#src/lib/rpc-query";
import { seedConditionModel } from "#src/lib/seed-condition-model";
import {
  clearNodeStatusesAtom,
  edgesAtom,
  nodesAtom,
  selectedNodeAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import { selectedExecutionIdAtom } from "#src/lib/workflow-ui-store";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { NodeConfigPatch } from "./node-config-patch";

/**
 * Writing a config change to the selected node, with everything that has to
 * settle at the same moment.
 *
 * This is the write half of `NodeConfigPanel`, kept out of it because the rules
 * below are worth reading on their own: which keys move together, what a
 * Condition node needs on arrival, and when a connection id may be repaired.
 * It was extracted when the panel was two components that had drifted, one of
 * which never cleared a stale connection as the action changed.
 */
export function useNodeConfigWriter() {
  const store = useStore();
  const queryClient = useQueryClient();
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const clearNodeStatuses = useSetAtom(clearNodeStatusesAtom);
  const setSelectedExecutionId = useSetAtom(selectedExecutionIdAtom);

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
      if (
        patch.actionType === BUILT_IN_ACTION_IDS.condition &&
        !newConfig.conditionModel
      ) {
        Object.assign(
          newConfig,
          seedConditionModel({
            nodeId: latestNode.id,
            nodes: latestNodes,
            edges: store.get(edgesAtom),
          })
        );
      }

      // Choosing an action is exactly when its connection can be settled, so
      // read the connection list from the cache here rather than closing over a
      // render's copy of it. Creating a connection from a node calls this
      // through a callback the overlay stack froze at push time, and a list
      // captured before that write does not contain the connection the user
      // just made: repairNodeIntegration would see an unknown id and either
      // rebind the node to the older connection of that type or, with none,
      // clear it.
      //
      // An entry that has never been fetched is not an empty connection list,
      // and the repair cannot tell them apart, so leave the node alone.
      const integrations = queryClient.getQueryData(
        integrationsQueryOptions().queryKey
      );

      const repaired = integrations
        ? repairNodeIntegration(
            { ...latestNode, data: { ...latestNode.data, config: newConfig } },
            integrations
          ).data.config
        : newConfig;

      updateNodeData({ id: latestNode.id, data: { config: repaired } });
    },
    [store, selectedNodeId, queryClient, updateNodeData]
  );

  /** Re-read the run list, behind the Refresh button above it. */
  const refreshRuns = useCallback(
    () => refreshRunHistory(queryClient),
    [queryClient]
  );

  /**
   * Clearing a workflow's run history, behind the panel's confirmation. The
   * success toast is part of it: written once per panel back when there were
   * two, one of them toasted and the other finished in silence.
   */
  const deleteRuns = useMutation(
    orpcQuery.workflow.deleteExecutions.mutationOptions({
      onSuccess: async () => {
        clearNodeStatuses();
        setSelectedExecutionId(null);
        await refreshRunHistory(queryClient);
        toast.success("All runs deleted");
      },
      meta: { errorMessage: "Failed to delete runs" },
    })
  );

  return { updateConfig, refreshRuns, deleteRuns };
}
