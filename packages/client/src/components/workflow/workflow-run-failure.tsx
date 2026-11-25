import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { EditConnectionOverlay } from "#src/components/overlays/edit-connection-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { useConnectionRepair } from "#src/hooks/use-connection-repair";
import { can } from "#src/lib/authorization";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import {
  describeFailure,
  type FailedStepConnection,
} from "#src/lib/run-failure";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import {
  findAction,
  findEntity,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";
import {
  ACTION_TYPE_CONFIG_KEY,
  readConfigString,
} from "@wfgraph/shared/graph/node-config";
import { cn } from "@wfgraph/shared/utils";

/**
 * A failure as the Runs view states it: a plain sentence, the stored error
 * beneath it as secondary text, and **Edit connection** when the failed step's
 * Connection refused or lacked its credentials. `nodeId` is the failed step,
 * read from the graph the run pinned, and null for a run that failed with no
 * step recorded.
 */
export function RunFailureText({
  error,
  nodeId,
  className,
}: {
  error: string;
  nodeId: string | null;
  /** The sentence's text classes, which differ between the band and Focus. */
  className?: string | undefined;
}) {
  const catalog = useExtensionCatalog();
  const { push } = useOverlay();
  const repairAgainstConnectionList = useConnectionRepair();
  const canReadConnections = can(WfGraphOperations.integrationGetAll.id);
  const canEditConnection = can(WfGraphOperations.integrationUpdate.id);
  const config = useAtomValue(executionOverlayGraphAtom)?.nodes.find(
    (node) => node.id === nodeId
  )?.data.config;
  const actionType = readConfigString(config, ACTION_TYPE_CONFIG_KEY);
  const action =
    actionType === undefined ? undefined : findAction(catalog, actionType);
  const integration = action?.integration
    ? findIntegration(catalog, action.integration)
    : undefined;
  const connectionId = readConfigString(config, "integrationId");
  const { data: connections } = useQuery({
    ...integrationsQueryOptions(),
    enabled: canReadConnections && integration !== undefined,
  });
  const connectionRecord = connections?.find(
    (item) => item.id === connectionId
  );
  // A Connection with no name is called what the step's Browse calls it.
  const connection: FailedStepConnection =
    connectionRecord !== undefined
      ? {
          kind: "named",
          name:
            connectionRecord.name ||
            `${integration?.label ?? connectionRecord.type} API Key`,
        }
      : connectionId && connections
        ? { kind: "deleted" }
        : { kind: "unknown" };
  const failure = describeFailure({
    error,
    integrationLabel: integration?.label ?? action?.integration ?? null,
    connection,
    entityLabel: (type) => findEntity(catalog, type)?.label ?? type,
  });

  return (
    <div className="space-y-1.5">
      <p className={cn("break-words", className)}>{failure.sentence}</p>
      {failure.detail === null ? null : (
        <p className="break-words font-mono text-muted-foreground text-xs">
          {failure.detail}
        </p>
      )}
      {failure.connectionCause &&
      connectionRecord !== undefined &&
      canEditConnection ? (
        <Button
          onClick={() =>
            push(EditConnectionOverlay, {
              integration: connectionRecord,
              onSuccess: repairAgainstConnectionList,
              onDelete: repairAgainstConnectionList,
            })
          }
          size="sm"
          type="button"
          variant="outline"
        >
          Edit connection
        </Button>
      ) : null}
    </div>
  );
}
