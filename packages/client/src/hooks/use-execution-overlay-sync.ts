import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useAfterCommit } from "#src/hooks/effects";
import type { ExecutionLogsResult } from "#src/lib/rpc-client";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  executionOverlayGraphAtom,
  resetNodeStatusesAtom,
} from "#src/lib/workflow-graph-store";
import { toEditorEdge, toEditorNode } from "#src/lib/workflow-graph-types";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  propertiesPanelActiveTabAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";

const workflowRouteApi = getRouteApi("/workflows/$workflowId");

/**
 * The fields the overlay sync needs from the logs payload: which workflow the
 * run belongs to, and which published version pins its graph. Logs and waits
 * stay on WorkflowRuns' own observer of the same query key.
 */
function toExecutionOverlaySource(payload: ExecutionLogsResult): {
  workflowId: string;
  workflowVersionId: string;
} {
  return {
    workflowId: payload.execution.workflowId,
    workflowVersionId: payload.execution.workflowVersionId,
  };
}

/**
 * URL search → canvas overlay wiring for the open run.
 *
 * Owns the selection atom ActionNode badges and `useExecutionLogsByNode` read,
 * the pinned-graph overlay, the Runs tab switch, and the node-status reset on
 * a run-to-run change. `WorkflowRuns` calls this and otherwise only queries
 * what its list and detail views display.
 */
export function useExecutionOverlaySync(): {
  executionId: string | undefined;
} {
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [selectedExecutionId, setSelectedExecutionId] = useAtom(
    selectedExecutionIdAtom
  );
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const setExecutionOverlay = useSetAtom(executionOverlayGraphAtom);
  const resetNodeStatuses = useSetAtom(resetNodeStatusesAtom);
  const { executionId } = workflowRouteApi.useSearch();

  // Opening a run enables the logs summary the sync reads workflowId and
  // versionId from. The panel's own observer of this key owns polling; this
  // one only needs the stable identity fields, so it carries no interval.
  const detailQuery = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: executionId ?? "" },
      select: toExecutionOverlaySource,
    }),
    enabled: executionId !== undefined,
    staleTime: 0,
  });

  // The pinned graph is immutable once published (ADR-0012), so it is fetched
  // once per workflowVersionId and cached forever rather than riding a polled
  // logs payload: `staleTime: Infinity` keeps it off the 2-second tick that
  // never has anything new to say about it.
  const versionId = detailQuery.data?.workflowVersionId;
  const graphQuery = useQuery({
    ...orpcQuery.workflow.getVersionGraph.queryOptions({
      input: { versionId: versionId ?? "" },
      select: (payload) => payload.graph,
    }),
    enabled: versionId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // URL search owns which run is open. One sync: selection, Runs tab, and the
  // pinned-graph overlay. Paint only when the run's workflowId matches the
  // hydrated editor (`currentWorkflowId`) — never before, or a late hydrate
  // clears the overlay while the key stays `ready` and the canvas sticks on
  // the draft. Key is closed | open:exec:wf | ready:exec:wf; never fetch
  // timestamps, so a logs poll cannot rebuild nodes as idle and wipe statuses.
  const detail = detailQuery.data;
  const graph = graphQuery.data;
  const executionWorkflowId = detail?.workflowId;
  const workflowAligned =
    detail !== undefined &&
    graph !== undefined &&
    executionWorkflowId === currentWorkflowId;
  useAfterCommit(
    executionId === undefined
      ? "closed"
      : workflowAligned
        ? `ready:${executionId}:${currentWorkflowId}`
        : `open:${executionId}:${currentWorkflowId ?? ""}`,
    () => {
      if (executionId === undefined) {
        setSelectedExecutionId(null);
        setExecutionOverlay(null);
        return;
      }

      // The server's node-status list only names nodes the run actually
      // reached, so moving the effective selection to a different run has to
      // drop what the previous one left behind before the new run's own
      // statuses land -- otherwise a node the new run never reaches goes on
      // reporting what the old run did. A repeat commit for the run already
      // open (a logs poll, or the open→ready transition of the same run)
      // must not reset, or it would wipe statuses the status poll just
      // painted for this very run.
      if (selectedExecutionId !== executionId) {
        resetNodeStatuses();
      }

      setActiveTab("runs");
      setSelectedExecutionId(executionId);

      if (!workflowAligned || detail === undefined || graph === undefined) {
        // Stay selection-only until hydrate, the run, and its graph all agree;
        // drop any stale overlay from the previous workflow rather than
        // paint-then-lose.
        setExecutionOverlay(null);
        return;
      }

      const graphData = toWorkflowGraphData(graph);
      setExecutionOverlay({
        nodes: graphData.nodes.map((node) => ({
          ...toEditorNode(node),
          selected: false,
        })),
        edges: graphData.edges.map(toEditorEdge),
      });
    }
  );

  return { executionId };
}
