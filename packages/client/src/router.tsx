import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { Provider } from "jotai";
import { GlobalModals } from "#src/components/global-modals";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { ThemeProvider } from "#src/components/theme-provider";
import { Toaster } from "#src/components/ui/sonner";
import { appStore } from "#src/lib/app-store";
import { getBasePath } from "#src/lib/base-path";
import { repairNodeIntegrations } from "#src/lib/node-integration";
import { getExtensionCatalog } from "#src/lib/extensions";
import { queryClient } from "#src/lib/query-client";
import { toSavedWorkflow } from "#src/lib/rpc-client";
import { integrationsQueryOptions, orpcQuery } from "#src/lib/rpc-query";
import { can, canInspectWorkflowRuns } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { hydrateWorkflowAtom } from "#src/lib/workflow-graph-store";
import {
  successfulSaveGenerationAtom,
  workflowLoadErrorAtom,
  workflowNotFoundAtom,
} from "#src/lib/workflow-save-store";
import {
  classifyWorkflowLoadFailure,
  authorizedWorkflowSearch,
  executionIdFromWorkflowSearch,
  publishWorkflowAfterCompletedSaves,
  WORKFLOW_LOAD_ERROR_MESSAGE,
} from "#src/lib/workflow-route-state";
import { enterRunsWorkspaceAtom } from "#src/lib/workflow-workspace-navigation";
import WorkflowEditorPage from "#src/routes/workflows/[workflowId]/page";
import WorkflowsPage from "#src/routes/workflows/page";

/** Which run the Runs panel has open, when any. */
export type WorkflowRouteSearch = {
  executionId?: string;
};

function validateWorkflowSearch(
  search: WorkflowRouteSearch & SearchSchemaInput
): WorkflowRouteSearch {
  return authorizedWorkflowSearch(search, canOpenDeepLinkedRun());
}

function canOpenDeepLinkedRun(): boolean {
  return can(WfGraphOperations.workflowGetById.id) && canInspectWorkflowRuns();
}

/**
 * The canvas belongs to the editor route and no other route has one, but the
 * provider sits above the outlet rather than beside the canvas. Two workflows
 * share a route, so the route component stays mounted between them either way;
 * what this position buys is leaving the dashboard and coming back, where the
 * canvas does unmount and would otherwise take the store with it.
 */
function LayoutContent() {
  return (
    <ReactFlowProvider>
      <Outlet />
    </ReactFlowProvider>
  );
}

function RootLayout() {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      disableTransitionOnChange
      enableSystem
    >
      <Provider store={appStore}>
        <OverlayProvider>
          <LayoutContent />
          <Toaster />
          <GlobalModals />
        </OverlayProvider>
      </Provider>
    </ThemeProvider>
  );
}

function WorkflowRouteComponent() {
  return <WorkflowEditorPage />;
}

const rootRoute = createRootRoute({
  component: RootLayout,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WorkflowsPage,
});

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
  component: () => <Navigate replace to="/" />,
});

const workflowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows/$workflowId",
  validateSearch: validateWorkflowSearch,
  /**
   * Put the workflow on screen before the editor renders.
   *
   * A loader avoids fetching from an effect after mounting, which would render
   * against the previous workflow's graph before a second render caught up, and
   * would need a ref comparing ids to discard a response that arrived after the
   * user had moved on. The router cancels a loader on navigation, so the
   * component's first render already has the right graph.
   *
   * The connection list comes along because a stored integrationId can have
   * gone stale since the last save, and repairing it here is what keeps that
   * repair out of a render effect too.
   *
   * `fetchQuery` and not `ensureQueryData`: the latter returns whatever is
   * cached without consulting staleness, so the `staleTime: 0` below did
   * nothing and reopening a workflow within the cache's lifetime rehydrated the
   * canvas from the copy fetched on the first visit. Edits made in between
   * vanished from the screen, and the next autosave wrote that older graph
   * back. `fetchQuery` honours both settings: the workflow is refetched every
   * time, and the connection list is refetched only when it has gone stale or a
   * connection write invalidated it.
   *
   * Run selection is not a loader concern: hydrating on `executionId` cleared
   * the pinned-graph overlay and left the canvas on the live draft.
   */
  loader: async ({ params, location, abortController }) => {
    const initialSaveGeneration =
      appStore.get(successfulSaveGenerationAtom).get(params.workflowId) ?? 0;
    const workflowQueryOptions = orpcQuery.workflow.getById.queryOptions({
      input: { workflowId: params.workflowId },
      staleTime: 0,
    });

    if (abortController.signal.aborted) {
      return;
    }

    appStore.set(workflowNotFoundAtom, false);
    appStore.set(workflowLoadErrorAtom, null);

    if (!can(WfGraphOperations.workflowGetById.id)) {
      const error = new Error(
        "You do not have permission to view this workflow."
      );
      appStore.set(workflowLoadErrorAtom, error.message);
      throw error;
    }

    const [workflowResult, integrationsResult] = await Promise.allSettled([
      queryClient.fetchQuery(workflowQueryOptions),
      can(WfGraphOperations.integrationGetAll.id)
        ? queryClient.fetchQuery(integrationsQueryOptions())
        : Promise.resolve([]),
    ]);
    const hasDeepLinkRunAccess =
      executionIdFromWorkflowSearch(location.search) !== undefined &&
      canOpenDeepLinkedRun();

    // Query cancellation and route cancellation are separate concerns. The
    // checks keep a loader that no longer owns the navigation from publishing
    // error state or hydrating its stale response into the shared editor store.
    if (abortController.signal.aborted) {
      return;
    }

    if (workflowResult.status === "rejected") {
      const failure = classifyWorkflowLoadFailure(workflowResult.reason);
      appStore.set(workflowNotFoundAtom, failure.notFound);
      appStore.set(workflowLoadErrorAtom, failure.message);
      throw workflowResult.reason;
    }

    if (integrationsResult.status === "rejected") {
      appStore.set(workflowLoadErrorAtom, WORKFLOW_LOAD_ERROR_MESSAGE);
      throw integrationsResult.reason;
    }

    try {
      await publishWorkflowAfterCompletedSaves({
        workflow: workflowResult.value,
        saveGeneration: initialSaveGeneration,
        getSaveGeneration: () =>
          appStore.get(successfulSaveGenerationAtom).get(params.workflowId) ??
          0,
        fetchWorkflow: () => queryClient.fetchQuery(workflowQueryOptions),
        publishWorkflow: (workflowSnapshot) => {
          const workflow = toSavedWorkflow(workflowSnapshot.workflow);
          appStore.set(hydrateWorkflowAtom, {
            ...workflow,
            saveGeneration: workflowSnapshot.saveGeneration,
            nodes: repairNodeIntegrations(
              getExtensionCatalog(),
              workflow.nodes,
              integrationsResult.value
            ),
          });
          if (hasDeepLinkRunAccess) {
            appStore.set(enterRunsWorkspaceAtom);
          }
        },
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      const failure = classifyWorkflowLoadFailure(error);
      appStore.set(workflowNotFoundAtom, failure.notFound);
      appStore.set(workflowLoadErrorAtom, failure.message);
      throw error;
    }
  },
  errorComponent: WorkflowRouteComponent,
  component: WorkflowRouteComponent,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  workflowsRoute,
  workflowRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  basepath: getBasePath(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
