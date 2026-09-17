import { useQuery } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { useAfterCommit } from "#src/hooks/effects";
import { toExecutionOverlaySource } from "#src/lib/execution-logs";
import { orpcQuery } from "#src/lib/rpc-query";
import { can } from "#src/lib/authorization";
import { executionOverlayGraphAtom } from "#src/lib/workflow-graph-store";
import { toEditorEdge, toEditorNode } from "#src/lib/workflow-graph-types";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { selectedExecutionIdAtom } from "#src/lib/workflow-ui-store";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

/**
 * The open run → pinned-graph overlay. The run is the one the route names,
 * read through `selectedExecutionIdAtom`.
 *
 * Private to `ExecutionOverlaySync`: the headless component is the mount API
 * so the editor tree shows who owns the sync.
 */
function useExecutionOverlaySync(): void {
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const executionId = useAtomValue(selectedExecutionIdAtom) ?? undefined;
  const setExecutionOverlay = useSetAtom(executionOverlayGraphAtom);
  const canReadLogs = can(WfGraphOperations.workflowGetExecutionLogs.id);
  const canReadVersionGraph = can(WfGraphOperations.workflowGetVersionGraph.id);

  // Identity fields for the overlay. The panel's observer of this key owns
  // polling for logs/waits; this one only needs stable workflowId/versionId,
  // same lifetime split as `useExecutionLogsByNode` on the canvas.
  const detailQuery = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: executionId ?? "" },
      select: toExecutionOverlaySource,
    }),
    enabled: executionId !== undefined && canReadLogs,
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
    enabled: versionId !== undefined && canReadVersionGraph,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // The route owns which run is open. One sync: the pinned-graph overlay.
  // Paint only when the run's workflowId matches the hydrated editor
  // (`currentWorkflowId`), never before, or the new run's graph lands on the
  // previous workflow's canvas. Never fetch timestamps, so a logs poll cannot
  // rebuild nodes as idle and wipe statuses.
  const detail = detailQuery.data;
  const graph = graphQuery.data;
  const workflowAligned =
    detail !== undefined &&
    graph !== undefined &&
    detail.workflowId === currentWorkflowId;
  useAfterCommit(
    executionId === undefined
      ? "closed"
      : workflowAligned
        ? `ready:${executionId}:${currentWorkflowId}`
        : `open:${executionId}:${currentWorkflowId ?? ""}`,
    () => {
      // Run statuses are `RunStatusProjection`'s to write, run by run, so
      // this sync moves only the pinned graph.
      if (executionId === undefined) {
        setExecutionOverlay(null);
        return;
      }

      if (
        detail === undefined ||
        graph === undefined ||
        detail.workflowId !== currentWorkflowId
      ) {
        // Stay selection-only until hydrate, the run, and its graph all agree;
        // drop any stale overlay from the previous workflow rather than
        // paint-then-lose.
        setExecutionOverlay(null);
        return;
      }

      const graphData = toWorkflowGraphData(graph);
      setExecutionOverlay({
        nodes: graphData.nodes.map(toEditorNode),
        edges: graphData.edges.map(toEditorEdge),
      });
    }
  );
}

/**
 * Headless owner of the canvas overlay for the run the route opens.
 *
 * Mount on the workflow editor shell so the pinned-graph overlay outlives the
 * Runs panel; the panel only queries what its list and detail views display.
 */
export function ExecutionOverlaySync() {
  useExecutionOverlaySync();
  return null;
}
