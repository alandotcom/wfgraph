/**
 * What is wrong with the graph: the passive pass that keeps badges and the
 * toolbar count in step with the canvas, and the hooks that open that list.
 *
 * The collector is mounted once, by the canvas. It needs three things the store
 * cannot reach on its own -- the graph, the extension catalog (React context)
 * and the operator's connection list (query cache) -- so this module is where
 * they meet, and opening the list needs the same three.
 *
 * The graph is debounced because a drag rewrites the node array every frame and
 * a position cannot change a verdict. Everything else is derived in render.
 */

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { WorkflowIssuesOverlay } from "#src/components/overlays/workflow-issues-overlay";
import {
  useAfterPaint,
  useDebouncedValue,
  useAfterCommit,
} from "#src/hooks/effects";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { can } from "#src/lib/authorization";
import { edgesAtom, nodesAtom } from "#src/lib/workflow-graph-store";
import { workspaceAddressFromSearch } from "#src/lib/workflow-navigation-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  toPersistedEdge,
  toPersistedNodes,
} from "#src/lib/workflow-graph-types";
import {
  collectAllWorkflowIssues,
  NO_ISSUES,
  sameIssues,
  workflowIssuesAtom,
} from "#src/lib/workflow-issues-store";
import { useProviderFieldIssues } from "#src/hooks/use-provider-field-issues";
import {
  rememberedRouteSearchesAtom,
  setWorkspaceSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { groupWorkflowIssuesForOverlay } from "@wfgraph/shared/graph/workflow-issues";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

/** How long the canvas must sit still before it is validated again. */
const SETTLE_MS = 300;

export function useCollectWorkflowIssues(): void {
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const catalog = useExtensionCatalog();
  const { data: integrations } = useQuery({
    ...integrationsQueryOptions(),
    enabled: can(WfGraphOperations.integrationGetAll.id),
  });
  const setIssues = useSetAtom(workflowIssuesAtom);

  // Nodes and edges settle together, so the Group rules never pair one pass's
  // members with another pass's edges.
  const graph = useMemo(() => ({ nodes, edges }), [nodes, edges]);
  const settledGraph = useDebouncedValue(graph, SETTLE_MS);
  const persisted = useMemo(
    () => toPersistedNodes(settledGraph.nodes),
    [settledGraph]
  );
  const persistedEdges = useMemo(
    () => settledGraph.edges.map(toPersistedEdge),
    [settledGraph]
  );
  // What the operator's own connections say a provider-backed field still needs.
  // The shared collector cannot ask, so these are raised here and merged into
  // the settled list the badge, count, and manually opened issue overlay read.
  const providerIssues = useProviderFieldIssues(persisted, catalog);

  const issues = useMemo(() => {
    // `undefined` is "the connection list has not arrived", which is a
    // different answer from "this operator has no connections". Defaulting it
    // to `[]` accused every node that named a connection, and -- because the
    // literal was new each render -- wrote the atom, re-rendered the canvas,
    // and arrived back here without bound.
    if (!integrations) {
      return NO_ISSUES;
    }

    return collectAllWorkflowIssues({
      nodes: persisted,
      edges: persistedEdges,
      catalog,
      integrations,
      providerIssues,
    });
  }, [persisted, persistedEdges, catalog, integrations, providerIssues]);

  // Keeping the previous list when the verdict has not changed is what stops
  // this from undoing #116: every settle recollects, and a content-identical
  // answer written as a fresh array would rebuild each summary, miss the paint
  // cache in `displayNodesAtom`, and repaint every flagged card for nothing.
  useAfterCommit(issues, () => {
    setIssues((previous) => (sameIssues(previous, issues) ? previous : issues));
  });
}

/**
 * Open a step, and optionally put the cursor in the field an issue named.
 *
 * The panel holding that field mounts in the commit this triggers, which is why
 * the focus waits for the next paint rather than for a timeout: the version this
 * replaced raced the panel and won only because the panel is fast.
 */
export function useGoToStep(): (nodeId: string, fieldKey?: string) => void {
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const setWorkspaceSelection = useSetAtom(setWorkspaceSelectionAtom);
  const [pendingFieldFocus, setPendingFieldFocus] = useState<string | null>(
    null
  );

  useAfterPaint(pendingFieldFocus, () => {
    if (!pendingFieldFocus) {
      return;
    }
    setPendingFieldFocus(null);
    const element = document.getElementById(pendingFieldFocus);
    if (!element) {
      return;
    }
    element.focus();
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  return useCallback(
    (nodeId: string, fieldKey?: string) => {
      // The step is selected in the Draft address the route is about to show,
      // so the selection is Draft's own whichever workspace asked.
      const search = store.get(rememberedRouteSearchesAtom).draft ?? {};
      setWorkspaceSelection({
        address: workspaceAddressFromSearch(
          store.get(currentWorkflowIdAtom) ?? "",
          search
        ),
        selection: { nodeIds: [nodeId], edgeIds: [] },
      });
      void navigate({ search, replace: true });
      setPendingFieldFocus(fieldKey ?? null);
    },
    [navigate, setWorkspaceSelection, store]
  );
}

/**
 * Open the issues list on its own, for a reader who asked rather than for a run
 * that was refused. It offers no "Run draft anyway" for that reason.
 *
 * It opens the complete settled list that produced the visible badges and count.
 * Reading one atom keeps the graph and provider halves on the same snapshot;
 * recollecting only the graph half here could pair current nodes with provider
 * answers from the previous graph or workflow.
 */
export function useShowWorkflowIssues(): () => void {
  const { open: openOverlay } = useOverlay();
  const goToStep = useGoToStep();
  const issues = useAtomValue(workflowIssuesAtom);

  return useCallback(() => {
    openOverlay(WorkflowIssuesOverlay, {
      issues: groupWorkflowIssuesForOverlay(issues),
      onGoToStep: goToStep,
      allowRunDraftAnyway: false,
    });
  }, [issues, openOverlay, goToStep]);
}
