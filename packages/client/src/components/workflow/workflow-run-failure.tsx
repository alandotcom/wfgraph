import { getNodeDisplayName } from "@wfgraph/shared/graph/node-display";
import { workflowStepNumbers } from "@wfgraph/shared/graph/workflow-outline";
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
  failedRunAftermath,
  type FailedStepConnection,
  type RunEntitySource,
} from "#src/lib/run-failure";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import {
  type ExtensionCatalog,
  findAction,
  findEntity,
  findEvent,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
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
 * step recorded. `startEventName` is the Event that started the run, which the
 * sentence names when the run's Entity was not found.
 */
export function RunFailureText({
  error,
  nodeId,
  startEventName = null,
  className,
  detailClassName = "text-muted-foreground",
}: {
  error: string;
  nodeId: string | null;
  startEventName?: string | null | undefined;
  /** The sentence's text classes, which differ between the band and Focus. */
  className?: string | undefined;
  /**
   * The stored error line's color. Muted by default; the failure band sets
   * it in foreground text, since muted text on the band's red tint measures
   * under 4.5:1.
   */
  detailClassName?: string | undefined;
}) {
  const catalog = useExtensionCatalog();
  const { push } = useOverlay();
  const repairAgainstConnectionList = useConnectionRepair();
  const canReadConnections = can(WfGraphOperations.integrationGetAll.id);
  const canEditConnection = can(WfGraphOperations.integrationUpdate.id);
  const pinnedNodes = useAtomValue(executionOverlayGraphAtom)?.nodes ?? [];
  const config = pinnedNodes.find((node) => node.id === nodeId)?.data.config;
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
    entitySource: runEntitySource({
      nodes: pinnedNodes,
      startEventName,
      catalog,
    }),
  });

  return (
    <div className="space-y-1.5">
      <p className={cn("break-words", className)}>{failure.sentence}</p>
      {failure.detail === null ? null : (
        <p className={cn("break-words font-mono text-xs", detailClassName)}>
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

/**
 * The Event that started a run and the Entity binding its pinned Lifecycle
 * Rules chose for that Event, or null when the run started with no Event or
 * the graph has not loaded.
 */
function runEntitySource(input: {
  nodes: readonly WorkflowNode[];
  startEventName: string | null;
  catalog: ExtensionCatalog;
}): RunEntitySource | null {
  const { startEventName } = input;
  if (startEventName === null) {
    return null;
  }
  const binding = input.nodes
    .filter((node) => node.data.type === "lifecycle")
    .map((node) => readLifecycleRules(node.data.config)?.trackedEntity)
    .find((tracked) => tracked !== undefined)?.bindings[startEventName];
  return binding === undefined
    ? null
    : {
        eventLabel:
          findEvent(input.catalog, startEventName)?.label ?? startEventName,
        binding,
      };
}

/**
 * What a failed run left undone and that it is not retried, as two sentences
 * from `failedRunAftermath` over the graph the run pinned. `failedNodeId` is
 * the step the run failed at and `ranNodeIds` the steps it recorded an
 * execution of. The run summary and the failed step's evidence both show it.
 * Renders nothing before the pinned graph has loaded.
 */
export function FailedRunAftermath({
  failedNodeId,
  ranNodeIds,
  className,
}: {
  failedNodeId: string;
  ranNodeIds: ReadonlySet<string>;
  className?: string | undefined;
}) {
  const catalog = useExtensionCatalog();
  const graph = useAtomValue(executionOverlayGraphAtom);
  if (!graph) {
    return null;
  }
  const aftermath = failedRunAftermath({
    failedNodeId,
    nodes: graph.nodes,
    edges: graph.edges,
    ranNodeIds,
    numberOf: workflowStepNumbers({
      nodes: graph.nodes,
      edges: graph.edges,
      catalog,
    }),
    nameOf: (node) => getNodeDisplayName(catalog, node),
  });
  return (
    <div className={cn("space-y-1", className)} data-slot="run-aftermath">
      <p>{aftermath.notRun}</p>
      <p>{aftermath.next}</p>
    </div>
  );
}
