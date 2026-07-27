import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { Provider } from "jotai";
import { GlobalModals } from "@/components/global-modals";
import { OverlayProvider } from "@/components/overlays/overlay-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { PersistentCanvas } from "@/components/workflow/persistent-canvas";
import { appStore } from "@/lib/app-store";
import { getBasePath } from "@/lib/base-path";
import { repairNodeIntegrations } from "@/lib/node-integration";
import { queryClient } from "@/lib/query-client";
import { toSavedWorkflow } from "@/lib/rpc-client";
import { integrationsQueryOptions, orpcQuery } from "@/lib/rpc-query";
import { hydrateWorkflowAtom } from "@/lib/workflow-graph-store";
import { workflowNotFoundAtom } from "@/lib/workflow-save-store";
import WorkflowEditorPage from "@/routes/workflows/[workflowId]/page";
import WorkflowsPage from "@/routes/workflows/page";

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
  /**
   * Put the workflow on screen before the editor renders.
   *
   * The editor used to fetch this from an effect after mounting, which meant a
   * render against the previous workflow's graph, then a second one, and a ref
   * comparing ids to discard a response that arrived after the user had moved
   * on. A loader has neither problem: the router cancels it on navigation, and
   * the component's first render already has the right graph.
   *
   * The connection list comes along because a stored integrationId can have
   * gone stale since the last save, and repairing it here is what keeps that
   * repair out of a render effect too.
   */
  loader: async ({ params }) => {
    try {
      const [payload, integrations] = await Promise.all([
        queryClient.ensureQueryData(
          orpcQuery.workflow.getById.queryOptions({
            input: { workflowId: params.workflowId },
            staleTime: 0,
          })
        ),
        queryClient.ensureQueryData(integrationsQueryOptions()),
      ]);

      const workflow = toSavedWorkflow(payload);
      appStore.set(hydrateWorkflowAtom, {
        ...workflow,
        nodes: repairNodeIntegrations(workflow.nodes, integrations),
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
