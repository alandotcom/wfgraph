import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { Provider } from "jotai";
import { GlobalModals } from "@/components/global-modals";
import { OverlayProvider } from "@/components/overlays/overlay-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { PersistentCanvas } from "@/components/workflow/persistent-canvas";
import HomePage from "@/frontend/app/page";
import WorkflowEditorPage from "@/frontend/app/workflows/[workflowId]/page";
import WorkflowsPage from "@/frontend/app/workflows/page";

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
      <Provider>
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
  const { workflowId } = useParams({ from: "/workflows/$workflowId" });
  return <WorkflowEditorPage workflowId={workflowId} />;
}

const rootRoute = createRootRoute({
  component: RootLayout,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
  component: WorkflowsPage,
});

const workflowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows/$workflowId",
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
});

declare module "@tanstack/react-router" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: module augmentation requires an interface
  interface Register {
    router: typeof router;
  }
}
