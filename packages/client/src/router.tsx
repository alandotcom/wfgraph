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
import { PersistentCanvas } from "#src/components/workflow/persistent-canvas";
import { appStore } from "#src/lib/app-store";
import { getBasePath } from "#src/lib/base-path";
import { repairNodeIntegrations } from "#src/lib/node-integration";
import { queryClient } from "#src/lib/query-client";
import { toSavedWorkflow } from "#src/lib/rpc-client";
import { integrationsQueryOptions, orpcQuery } from "#src/lib/rpc-query";
import { hydrateWorkflowAtom } from "#src/lib/workflow-graph-store";
import { workflowNotFoundAtom } from "#src/lib/workflow-save-store";
import {
  propertiesPanelActiveTabAtom,
  selectedExecutionIdAtom,
} from "#src/lib/workflow-ui-store";
import WorkflowEditorPage from "#src/routes/workflows/[workflowId]/page";
import WorkflowsPage from "#src/routes/workflows/page";

/** Which run the Runs panel has open, when any. */
export type WorkflowRouteSearch = {
  executionId?: string;
};

function validateWorkflowSearch(
  search: WorkflowRouteSearch & SearchSchemaInput
): WorkflowRouteSearch {
  return {
    executionId:
      typeof search.executionId === "string" && search.executionId.length > 0
        ? search.executionId
        : undefined,
  };
}

function LayoutContent() {
  return (
    <ReactFlowProvider>
      <PersistentCanvas />
      <div className="pointer-events-none relative z-10">
        <Outlet />
      </div>
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
  loaderDeps: ({ search }) => ({
    executionId: search.executionId,
  }),
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
   * An `executionId` search param opens the Runs tab (and selects that run) so
   * the panel that reads the same search is mounted on arrival.
   */
  loader: async ({ params, deps }) => {
    try {
      const [payload, integrations] = await Promise.all([
        queryClient.fetchQuery(
          orpcQuery.workflow.getById.queryOptions({
            input: { workflowId: params.workflowId },
            staleTime: 0,
          })
        ),
        queryClient.fetchQuery(integrationsQueryOptions()),
      ]);

      const workflow = toSavedWorkflow(payload);
      appStore.set(hydrateWorkflowAtom, {
        ...workflow,
        nodes: repairNodeIntegrations(workflow.nodes, integrations),
      });

      if (deps.executionId) {
        appStore.set(propertiesPanelActiveTabAtom, "runs");
        appStore.set(selectedExecutionIdAtom, deps.executionId);
      }
    } catch (error) {
      appStore.set(workflowNotFoundAtom, true);
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
