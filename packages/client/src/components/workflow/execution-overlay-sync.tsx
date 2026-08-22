import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useAfterCommit } from "#src/hooks/effects";
import { toExecutionOverlaySource } from "#src/lib/execution-logs";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  executionOverlayGraphAtom,
  resetNodeStatusesAtom,
  workflowHydrateGenerationAtom,
} from "#src/lib/workflow-graph-store";
import { toEditorEdge, toEditorNode } from "#src/lib/workflow-graph-types";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { selectedExecutionIdAtom } from "#src/lib/workflow-ui-store";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";

const workflowRouteApi = getRouteApi("/workflows/$workflowId");

/**
 * URL search → selection atom and pinned-graph overlay for the open run.
 *
 * Private to `ExecutionOverlaySync`: the headless component is the mount API
 * so the editor tree shows who owns the sync.
 */
function useExecutionOverlaySync(): void {
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const [selectedExecutionId, setSelectedExecutionId] = useAtom(
    selectedExecutionIdAtom
  );
  const setExecutionOverlay = useSetAtom(executionOverlayGraphAtom);
  const resetNodeStatuses = useSetAtom(resetNodeStatusesAtom);
  const hydrateGeneration = useAtomValue(workflowHydrateGenerationAtom);
  const { executionId } = workflowRouteApi.useSearch();

  // Identity fields for the overlay. The panel's observer of this key owns
  // polling for logs/waits; this one only needs stable workflowId/versionId,
  // same lifetime split as `useExecutionLogsByNode` on the canvas.
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

  // URL search owns which run is open. One sync: selection and the
  // pinned-graph overlay. Paint only when the run's workflowId matches the
  // hydrated editor (`currentWorkflowId`) — never before, or a late hydrate
  // clears the overlay while the key stays `ready` and the canvas sticks on
  // the draft. `hydrateGeneration` is in the key so a same-workflow reload
  // (dashboard round-trip, stale-while-revalidate) re-runs this after hydrate
  // has cleared the overlay. Never fetch timestamps, so a logs poll cannot
  // rebuild nodes as idle and wipe statuses.
  const detail = detailQuery.data;
  const graph = graphQuery.data;
  const workflowAligned =
    detail !== undefined &&
    graph !== undefined &&
    detail.workflowId === currentWorkflowId;
  useAfterCommit(
    executionId === undefined
      ? `closed:${hydrateGeneration}`
      : workflowAligned
        ? `ready:${executionId}:${currentWorkflowId}:${hydrateGeneration}`
        : `open:${executionId}:${currentWorkflowId ?? ""}:${hydrateGeneration}`,
    () => {
      if (executionId === undefined) {
        setSelectedExecutionId(null);
        setExecutionOverlay(null);
        resetNodeStatuses();
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

      setSelectedExecutionId(executionId);

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
        nodes: graphData.nodes.map((node) => ({
          ...toEditorNode(node),
          selected: false,
        })),
        edges: graphData.edges.map(toEditorEdge),
      });
    }
  );
}

/**
 * Headless owner of URL → canvas overlay wiring for the open run.
 *
 * Mount on the workflow editor shell so selection and the pinned-graph
 * overlay outlive the Runs panel. ActionNode badges and
 * `useExecutionLogsByNode` read the selection atom this writes; the panel
 * only queries what its list and detail views display.
 *
 * Opening the Runs tab for a deep link is the route `beforeLoad`, not this
 * component: the shell is already mounted before that tab paints.
 */
export function ExecutionOverlaySync() {
  useExecutionOverlaySync();
  return null;
}
