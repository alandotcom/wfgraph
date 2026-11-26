import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useAtomValueRawSync, useSetAtom, useStore } from "jotai";
import { useAfterCommit, useBeforePaint } from "#src/hooks/effects";
import { orpcQuery } from "#src/lib/rpc-query";
import { requestedReviewAtom } from "#src/lib/workflow-review-store";
import {
  presentedGraphAtom,
  presentedGraphStructureAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { firstStepOfGroup } from "#src/lib/workflow-graph-structure";
import { stepNumbersAtom } from "#src/lib/step-numbers";
import {
  recoveredRouteSearch,
  selectionInGraph,
  workspaceAddressFromSearch,
  workspaceAddressId,
  workspaceRouteSearch,
  type NavigationGraph,
  type WorkflowRouteSearch,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import { isNotFoundError } from "#src/lib/workflow-route-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  activeRevealPresentationAtom,
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  applyWorkspaceRouteAtom,
  keepActiveInspectionInGraphAtom,
} from "#src/lib/workflow-workspace-navigation";

const workflowRouteApi = getRouteApi("/workflows/$workflowId");

/** The workspace state recovery reads, from one render or from the store. */
type RecoveryInputs = {
  routeReady: boolean;
  address: WorkspaceAddress;
  presentedGraph: NavigationGraph | null;
};

/**
 * The graph recovery may judge the active address against. Runs has one once
 * the open run's graph arrives.
 */
function recoveryGraph(inputs: RecoveryInputs): NavigationGraph | null {
  return inputs.routeReady ? inputs.presentedGraph : null;
}

/**
 * The route search recovery replaces `search` with. An older link's `group`
 * waits for the graph, since the step it lands on is read from that graph.
 */
function recoveredSearch(
  inputs: RecoveryInputs,
  search: WorkflowRouteSearch,
  runMissing: boolean
): WorkflowRouteSearch {
  if (search.group !== undefined && recoveryGraph(inputs) === null) {
    return search;
  }
  return recoveredRouteSearch({ search, runMissing });
}

/**
 * Keeps workspace navigation in agreement with the editor route.
 *
 * The route search is the system of record for the active address. This hook
 * applies it to the store before paint, hands a review request in the route to
 * Draft, drops selected ids the presented graph no longer holds, and replaces
 * the route when what it names cannot be opened or once it has handed on its
 * review request. Those replacements are the only writes from workspace state
 * back to the route.
 */
function useWorkspaceRouteSync(): void {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const { workflowId: routeWorkflowId } = workflowRouteApi.useParams();
  const search = workflowRouteApi.useSearch();
  const applyRoute = useSetAtom(applyWorkspaceRouteAtom);
  // This hook and sibling synchronizers write these atoms before subscriptions
  // mount, so every read must catch that same-commit update.
  const currentWorkflowId = useAtomValueRawSync(currentWorkflowIdAtom);
  const address = useAtomValueRawSync(activeWorkspaceAddressAtom);
  const selection = useAtomValueRawSync(activeSelectionAtom);
  const inspected = useAtomValueRawSync(activeRevealPresentationAtom).inspected;
  // The structure alone, so a drag that only moves nodes does not re-render.
  const presentedStructure = useAtomValueRawSync(presentedGraphStructureAtom);
  const routeReady = currentWorkflowId === routeWorkflowId;
  const routeAddressId = workspaceAddressId(
    workspaceAddressFromSearch(routeWorkflowId, search)
  );

  // Before paint, so every after-commit effect in this commit, including
  // `ExecutionOverlaySync` and the canvas, reads the address the route names.
  useBeforePaint(routeAddressId, () => {
    applyRoute({ workflowId: routeWorkflowId, search });
  });

  // A route asking for the review hands the request to the toolbar, which
  // opens the sheet the way Publish does, and then leaves the route.
  useAfterCommit(
    routeReady && search.review === true ? routeWorkflowId : null,
    () => {
      // The effect also runs on mount and when the request leaves the route,
      // so a route that does not ask for the review requests nothing.
      if (
        search.review !== true ||
        store.get(currentWorkflowIdAtom) !== routeWorkflowId
      ) {
        return;
      }
      store.set(requestedReviewAtom, routeWorkflowId);
      // The address names every key Draft keeps, so the request and any
      // key of the old Changes link leave the route together.
      void navigate({
        search: workspaceRouteSearch(
          workspaceAddressFromSearch(routeWorkflowId, search)
        ),
        replace: true,
      });
    }
  );

  const renderedInputs: RecoveryInputs = {
    routeReady,
    address,
    presentedGraph: presentedStructure?.graph ?? null,
  };
  // Effect bodies read the store, because a sibling effect earlier in the same
  // commit, such as `ExecutionOverlaySync` dropping a run graph, may have
  // replaced what this render saw.
  const storedInputs = (): RecoveryInputs => ({
    routeReady: store.get(currentWorkflowIdAtom) === routeWorkflowId,
    address: store.get(activeWorkspaceAddressAtom),
    presentedGraph: store.get(presentedGraphAtom),
  });

  // Selected ids, and the object the Inspector inspects, that the
  // presented graph no longer holds are dropped. The key names only the graph
  // structure, so moving a node does not run it again.
  const renderedGraph = recoveryGraph(renderedInputs);
  const hasSelection =
    selection.nodeIds.length > 0 || selection.edgeIds.length > 0;
  useAfterCommit(
    renderedGraph && presentedStructure && (hasSelection || inspected)
      ? `${workspaceAddressId(address)}|${selection.nodeIds.join(",")}|${selection.edgeIds.join(",")}|${inspected?.id ?? ""}|${presentedStructure.key}`
      : null,
    () => {
      const inputs = storedInputs();
      const graph = recoveryGraph(inputs);
      if (graph) {
        store.set(
          activeSelectionAtom,
          selectionInGraph(store.get(activeSelectionAtom), graph)
        );
        store.set(keepActiveInspectionInGraphAtom, graph);
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
      if (!inputs.routeReady || next === search) {
        return;
      }
      // An older link named a Group the editor once showed on a canvas of
      // its own. The Group now draws in place, so the link selects its first
      // step on the one canvas.
      const graph = recoveryGraph(inputs);
      if (search.group !== undefined && graph !== null) {
        const stepId = firstStepOfGroup({
          graph,
          groupId: search.group,
          stepNumbers: store.get(stepNumbersAtom),
        });
        if (stepId !== null) {
          store.set(selectOnlyNodeAtom, stepId);
        }
      }
      void navigate({ search: next, replace: true });
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
