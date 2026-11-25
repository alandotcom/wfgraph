import { useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { repairIntegrationsAtom } from "#src/lib/workflow-graph-store";

/**
 * Reconcile every Action, Lifecycle, and Wait binding in the open graph with
 * the connection list after a write changes it. An Action step keeps the id of
 * a deleted Connection, so it reports the deletion; `chosen` is a Connection
 * the person just created to fill the steps that need its type.
 *
 * Every place that creates or deletes a connection while a graph is on screen
 * calls this. Refreshing the list on its own leaves each node's stored
 * connection id as it was, and that id is what validation and delivery read.
 *
 * A plain `query` and not a `query` at `staleTime: "static"`: the write has
 * just invalidated that entry, and a static read answers from the cache without
 * consulting staleness, so the repair would run against the list as it stood
 * before.
 */
export function useConnectionRepair() {
  const queryClient = useQueryClient();
  const catalog = useExtensionCatalog();
  const repairIntegrations = useSetAtom(repairIntegrationsAtom);

  return useCallback(
    async (chosen?: { id: string; type: string }) => {
      if (!can(WfGraphOperations.integrationGetAll.id)) {
        return;
      }
      repairIntegrations({
        integrations: await queryClient.query(integrationsQueryOptions()),
        catalog,
        chosen,
      });
    },
    [queryClient, repairIntegrations, catalog]
  );
}
