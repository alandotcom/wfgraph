/**
 * The toolbar fixtures both publish suites render against.
 *
 * `renderProbe` stands a probe inside the providers `useWorkflowActions` reads
 * from, and its query client fails the way the app's does, so a suite can say
 * what a mutation's failure reaches the screen as.
 */

import {
  MutationCache,
  QueryClient,
  type QueryClientConfig,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRoute,
  createRootRoute,
  createRouter,
  RouterProvider,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider, useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import {
  OverlayProvider,
  useOverlay,
} from "#src/components/overlays/overlay-provider";
import { useWorkflowActions } from "#src/components/workflow/workflow-toolbar-handlers";
import type { WorkflowToolbarState } from "#src/components/workflow/workflow-toolbar-state";
import { mutationErrorToast } from "#src/lib/query-client";
import { toSerializedGraph } from "#src/lib/rpc-client";
import { canvasEditingLockedAtom } from "#src/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  recordLoadedDraftRevisionAtom,
} from "#src/lib/workflow-save-store";
import { toEditorNode } from "#src/lib/workflow-graph-types";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

export const workflowId = "workflow_1";

export const graph = createSerializedWorkflowGraph({
  nodes: [
    {
      id: "lifecycle_1",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: { label: "Lifecycle", type: "lifecycle" },
    },
  ],
  edges: [],
});

export const nodes = toWorkflowGraphData(graph).nodes.map(toEditorNode);

/** The graph as the toolbar sends it, which is what a request is checked against. */
export const expectedSnapshot = toSerializedGraph({ nodes, edges: [] });

export const catalog: ExtensionCatalog = {
  actions: [],
  events: [],
  integrations: [],
};

export function workflowStore(id = workflowId) {
  const store = createStore();
  store.set(currentWorkflowIdAtom, id);
  store.set(recordLoadedDraftRevisionAtom, {
    workflowId: id,
    draftRevision: 1,
  });
  return store;
}

export function state(): WorkflowToolbarState {
  return {
    nodes,
    edges: [],
    isExecuting: false,
    setIsExecuting: vi.fn(),
    isGenerating: false,
    clearWorkflow: vi.fn(),
    updateNodeData: vi.fn(),
    currentWorkflowId: workflowId,
    workflowName: "Workflow",
    workflowMode: "test",
    setCurrentWorkflowMode: vi.fn(),
    canUpdate: true,
    canExecute: true,
    canReadRuns: true,
    canReadVersionHistory: true,
    canCompare: true,
    canCreate: true,
    canDuplicate: true,
    canDelete: true,
    canPublish: true,
    canReadVersionGraph: true,
    isSaving: false,
    hasUnsavedChanges: true,
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: false,
    canRedo: false,
    allWorkflows: [],
    setSelectedNodeId: vi.fn(),
    userIntegrations: [],
    publication: {
      isPublished: true,
      hasUnpublishedChanges: true,
      publishedVersionId: "version_7",
      publishedVersion: 7,
      publishedAt: "2026-08-23T15:00:00.000Z",
    },
  };
}

export function deferred<T>() {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolveDeferred = resolvePromise;
  });
  return { promise, resolve: (value: T) => resolveDeferred(value) };
}

/**
 * A client that toasts a failed mutation the way the running editor does.
 *
 * The mutation cache is the handler that survives an unmount, so a suite
 * rendering without it would read every failure a call site did not answer as
 * silence.
 */
export function testQueryClient(config: QueryClientConfig = {}): QueryClient {
  return new QueryClient({
    ...config,
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const message = mutationErrorToast(error, mutation.meta);
        if (message !== null) {
          toast.error(message);
        }
      },
    }),
  });
}

export function PublishProbe({
  workflowState = state(),
}: {
  workflowState?: WorkflowToolbarState;
}) {
  const actions = useWorkflowActions(workflowState);
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  const { stack } = useOverlay();
  return (
    <>
      <button onClick={actions.handlePublish} type="button">
        Start publish
      </button>
      <button onClick={() => void actions.handleExecute("draft")} type="button">
        Run draft
      </button>
      <button onClick={actions.confirmPublish} type="button">
        Confirm publish
      </button>
      <button onClick={() => actions.setPublishReviewOpen(false)} type="button">
        Cancel review
      </button>
      <output>{actions.publishReview ? "ready" : "idle"}</output>
      <output aria-label="editing lock">{String(editingLocked)}</output>
      <output aria-label="provider preflight">
        {String(actions.isPreflighting)}
      </output>
      <output aria-label="overlay count">{stack.length}</output>
    </>
  );
}

export function renderProbe({
  probe = <PublishProbe />,
  extensionCatalog = catalog,
  store = workflowStore(),
  queryClient = testQueryClient(),
}: {
  probe?: ReactNode;
  extensionCatalog?: ExtensionCatalog;
  store?: ReturnType<typeof workflowStore>;
  queryClient?: QueryClient;
} = {}) {
  const rootRoute = createRootRoute({ component: () => probe });
  // A started run navigates here through `navigateToExecution` in
  // workflow-run-actions.ts, so the route must exist or that call throws on an
  // unmatched path. The route's component never renders, because the root
  // component has no `<Outlet />`.
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: { executionId?: string } & SearchSchemaInput) => ({
      executionId:
        typeof search.executionId === "string" && search.executionId.length > 0
          ? search.executionId
          : undefined,
    }),
    component: () => null,
  });

  return render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ReactFlowProvider>
          <ExtensionCatalogProvider value={extensionCatalog}>
            <OverlayProvider>
              <RouterProvider
                router={createRouter({
                  routeTree: rootRoute.addChildren([workflowRoute]),
                  history: createMemoryHistory({ initialEntries: ["/"] }),
                })}
              />
            </OverlayProvider>
          </ExtensionCatalogProvider>
        </ReactFlowProvider>
      </QueryClientProvider>
    </JotaiProvider>
  );
}
