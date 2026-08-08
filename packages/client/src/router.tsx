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
import { getExtensionCatalog } from "#src/lib/extensions";
import { queryClient } from "#src/lib/query-client";
import { toSavedWorkflow } from "#src/lib/rpc-client";
import { integrationsQueryOptions, orpcQuery } from "#src/lib/rpc-query";
import { hydrateWorkflowAtom } from "#src/lib/workflow-graph-store";
import { workflowNotFoundAtom } from "#src/lib/workflow-save-store";
import { propertiesPanelActiveTabAtom } from "#src/lib/workflow-ui-store";
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
  /**
   * Open the Runs tab on a deep-linked run so the panel is what the builder
   * sees. Selection and overlay are the editor shell's
   * `useExecutionOverlaySync`, not this panel — hydrate clears those, and the
   * shell rewrites them after mount. Safe on every search change: selecting a
   * run must not re-hydrate.
   */
  beforeLoad: ({ search }) => {
    if (search.executionId) {
      appStore.set(propertiesPanelActiveTabAtom, "runs");
    }
  },
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
  loader: async ({ params }) => {
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
        nodes: repairNodeIntegrations(
          getExtensionCatalog(),
          workflow.nodes,
          integrations
        ),
      });
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
