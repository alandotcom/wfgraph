import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import { useAfterCommit, useBeforePaint } from "#src/hooks/effects";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  comparisonSessionAtom,
  missingComparisonBaseIdAtom,
  isComparisonPendingAtom,
} from "#src/lib/workflow-comparison-store";
import {
  presentedGraphAtom,
  presentedGraphStructureAtom,
} from "#src/lib/workflow-graph-store";
import {
  groupScopeExists,
  recoveredRouteSearch,
  selectionInGraph,
  workspaceAddressFromSearch,
  workspaceAddressId,
  type NavigationGraph,
  type WorkflowRouteSearch,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import { isNotFoundError } from "#src/lib/workflow-route-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  applyWorkspaceRouteAtom,
} from "#src/lib/workflow-workspace-navigation";

const workflowRouteApi = getRouteApi("/workflows/$workflowId");

/** The workspace state recovery reads, from one render or from the store. */
type RecoveryInputs = {
  routeReady: boolean;
  address: WorkspaceAddress;
  presentedGraph: NavigationGraph | null;
  comparisonPending: boolean;
  missingComparisonBaseId: string | null;
  /** The installed comparison's base version id, null for a first publication. */
  comparisonBaseId: string | null | undefined;
};

/**
 * The graph recovery may judge the active address against. Runs has one once
 * the open run's graph arrives. Changes has one once the installed comparison
 * is settled and is the comparison the address names.
 */
function recoveryGraph(inputs: RecoveryInputs): NavigationGraph | null {
  const { key } = inputs.address;
  const comparisonCurrent =
    key.workspace !== "changes" ||
    (!inputs.comparisonPending &&
      (key.baseVersionId === null ||
        inputs.comparisonBaseId === key.baseVersionId));
  return inputs.routeReady && comparisonCurrent ? inputs.presentedGraph : null;
}

function recoveredSearch(
  inputs: RecoveryInputs,
  search: WorkflowRouteSearch,
  runMissing: boolean
): WorkflowRouteSearch {
  const graph = recoveryGraph(inputs);
  return recoveredRouteSearch({
    search,
    groupMissing:
      graph !== null && !groupScopeExists(inputs.address.scope, graph),
    runMissing,
    missingComparisonBaseId: inputs.missingComparisonBaseId,
    installedComparisonBaseId: inputs.comparisonPending
      ? undefined
      : inputs.comparisonBaseId,
  });
}

/**
 * Keeps workspace navigation in agreement with the editor route.
 *
 * The route search is the system of record for the active address. This hook
 * applies it to the store before paint, opens the comparison a Changes route
 * names, drops selected ids the presented graph no longer holds, and replaces
 * the route when what it names cannot be opened. That replacement is the only
 * write from workspace state back to the route.
 */
function useWorkspaceRouteSync(): void {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const { workflowId: routeWorkflowId } = workflowRouteApi.useParams();
  const search = workflowRouteApi.useSearch();
  const applyRoute = useSetAtom(applyWorkspaceRouteAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const address = useAtomValue(activeWorkspaceAddressAtom);
  const selection = useAtomValue(activeSelectionAtom);
  // The structure alone, so a drag that only moves nodes does not re-render.
  const presentedStructure = useAtomValue(presentedGraphStructureAtom);
  const session = useAtomValue(comparisonSessionAtom);
  const isComparisonPending = useAtomValue(isComparisonPendingAtom);
  const missingComparisonBaseId = useAtomValue(missingComparisonBaseIdAtom);
  const { openComparison } = useWorkflowComparisonActions();
  const routeReady = currentWorkflowId === routeWorkflowId;
  const routeAddressId = workspaceAddressId(
    workspaceAddressFromSearch(routeWorkflowId, search)
  );

  // Before paint, so every after-commit effect in this commit, including
  // `ExecutionOverlaySync` and the canvas, reads the address the route names.
  useBeforePaint(routeAddressId, () => {
    applyRoute({ workflowId: routeWorkflowId, search });
  });

  // A Changes route opens its comparison. A route naming no base opens the
  // current publication only when no comparison is installed, because a
  // retained comparison is still the one the route shows.
  const comparisonTarget =
    routeReady && search.view === "changes"
      ? `${routeWorkflowId}|${search.compare ?? ""}`
      : null;
  useAfterCommit(comparisonTarget, () => {
    if (comparisonTarget === null) {
      return;
    }
    const installed = store.get(comparisonSessionAtom);
    if (search.compare === undefined) {
      if (installed === null) {
        void openComparison();
      }
    } else if (installed?.payload.baseVersion?.id !== search.compare) {
      void openComparison({ baseVersionId: search.compare });
    }
  });

  const renderedInputs: RecoveryInputs = {
    routeReady,
    address,
    presentedGraph: presentedStructure?.graph ?? null,
    comparisonPending: isComparisonPending,
    missingComparisonBaseId,
    comparisonBaseId: session
      ? (session.payload.baseVersion?.id ?? null)
      : undefined,
  };
  // Effect bodies read the store, because a sibling effect earlier in the same
  // commit, such as `ExecutionOverlaySync` dropping a run graph, may have
  // replaced what this render saw.
  const storedInputs = (): RecoveryInputs => {
    const installed = store.get(comparisonSessionAtom);
    return {
      routeReady: store.get(currentWorkflowIdAtom) === routeWorkflowId,
      address: store.get(activeWorkspaceAddressAtom),
      presentedGraph: store.get(presentedGraphAtom),
      comparisonPending: store.get(isComparisonPendingAtom),
      missingComparisonBaseId: store.get(missingComparisonBaseIdAtom),
      comparisonBaseId: installed
        ? (installed.payload.baseVersion?.id ?? null)
        : undefined,
    };
  };

  // Selected ids the presented graph no longer holds are dropped. The key
  // names only the graph structure, so moving a node does not run it again.
  const renderedGraph = recoveryGraph(renderedInputs);
  const hasSelection =
    selection.nodeIds.length > 0 || selection.edgeIds.length > 0;
  useAfterCommit(
    renderedGraph && presentedStructure && hasSelection
      ? `${workspaceAddressId(address)}|${selection.nodeIds.join(",")}|${selection.edgeIds.join(",")}|${presentedStructure.key}`
      : null,
    () => {
      const graph = recoveryGraph(storedInputs());
      if (graph) {
        store.set(
          activeSelectionAtom,
          selectionInGraph(store.get(activeSelectionAtom), graph)
        );
      }
    }
  );

  // The run detail request `ExecutionOverlaySync` makes, observed without
  // starting another one.
  const runDetail = useQuery({
    ...orpcQuery.workflow.getExecutionLogs.queryOptions({
      input: { executionId: search.executionId ?? "" },
    }),
    enabled: false,
  });
  const runMissing = isNotFoundError(runDetail.error);
  const recovered = recoveredSearch(renderedInputs, search, runMissing);

  // The one write from workspace state to the route: replace what the route
  // names with the nearest address the editor can open.
  useAfterCommit(
    routeReady && recovered !== search
      ? workspaceAddressId(
          workspaceAddressFromSearch(routeWorkflowId, recovered)
        )
      : null,
    () => {
      const inputs = storedInputs();
      const next = recoveredSearch(inputs, search, runMissing);
      if (inputs.routeReady && next !== search) {
        void navigate({ search: next, replace: true });
      }
    }
  );
}

/**
 * Headless owner of the agreement between the editor route and workspace
 * navigation. Mount it once on the workflow editor shell.
 */
export function WorkspaceRouteSync() {
  useWorkspaceRouteSync();
  return null;
}
