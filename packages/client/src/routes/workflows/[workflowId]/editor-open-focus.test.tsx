import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
} from "#src/lib/workflow-save-store";
import WorkflowEditor from "#src/routes/workflows/[workflowId]/page";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

/**
 * The whole editor page. Opening a workflow from the Workflows table unmounts
 * the row that had focus, so the page decides where focus lands.
 */

const CATALOG: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [],
};

const NODES: WorkflowNode[] = [
  {
    id: "life",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Patient became inactive", type: "lifecycle" },
  },
];

async function renderEditorPage() {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(currentWorkflowNameAtom, "Patient reactivation");
  store.set(loadWorkflowGraphAtom, { nodes: NODES, edges: [] });

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const editorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: WorkflowRouteSearch & SearchSchemaInput) =>
      authorizedWorkflowSearch(search, { canOpenRuns: true, canReview: true }),
    component: WorkflowEditor,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([editorRoute]),
    history: createMemoryHistory({ initialEntries: ["/workflows/workflow_1"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["integration", "getAll"] as never, [] as never);

  return render(
    <ExtensionCatalogProvider value={CATALOG}>
      <IntegrationUiProvider value={{}}>
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>
            <ReactFlowProvider>
              <OverlayProvider>
                <RouterProvider router={router} />
              </OverlayProvider>
            </ReactFlowProvider>
          </JotaiProvider>
        </QueryClientProvider>
      </IntegrationUiProvider>
    </ExtensionCatalogProvider>
  );
}

beforeEach(() => {
  installAuthorizationGrantsForTests(WfGraphOperationIds);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthorizationGrantsForTests();
});

describe("WorkflowEditor when it opens", () => {
  it("puts focus on the outline's first row", async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const view = await renderEditorPage();

    const [row] = await view.findAllByRole("treeitem");
    await waitFor(() => expect(document.activeElement).toBe(row));
  });
});
