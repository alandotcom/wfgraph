import { useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { repairIntegrationsAtom } from "#src/lib/workflow-graph-store";

/**
 * Point every node in the open graph at a connection that exists, after a write
 * that changed the connection list.
 *
 * Every place that creates or deletes a connection while a graph is on screen
 * calls this. Refreshing the list on its own leaves each node's stored
 * `integrationId` as it was, and that id is what the pre-run check reads.
 *
 * `fetchQuery` and not `ensureQueryData`: the write has just invalidated that
 * entry, and `ensureQueryData` answers from the cache without consulting
 * staleness, so the repair would run against the list as it stood before.
 */
export function useConnectionRepair() {
  const queryClient = useQueryClient();
  const catalog = useExtensionCatalog();
  const repairIntegrations = useSetAtom(repairIntegrationsAtom);

  return useCallback(async () => {
    repairIntegrations({
      integrations: await queryClient.fetchQuery(integrationsQueryOptions()),
      catalog,
    });
  }, [queryClient, repairIntegrations, catalog]);
}
