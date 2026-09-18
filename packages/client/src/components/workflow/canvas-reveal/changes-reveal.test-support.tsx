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
import { act, fireEvent, render, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider, useAtomValue } from "jotai";
import { vi } from "vitest";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import type { WorkflowNode as PersistedWorkflowNode } from "@wfgraph/shared/graph/types";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { CanvasReveal } from "#src/components/workflow/canvas-reveal/canvas-reveal";
import {
  MobileReveal,
  MobileRevealCovered,
} from "#src/components/workflow/canvas-reveal/mobile-reveal";
import { useWorkflowNodeInspection } from "#src/components/workflow/use-workflow-node-inspection";
import { WorkflowCanvas } from "#src/components/workflow/workflow-canvas";
import {
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import {
  beginWorkflowComparisonRequestAtom,
  comparisonDisplayGraphAtom,
  installWorkflowComparisonAtom,
  settleWorkflowComparisonRequestAtom,
} from "#src/lib/workflow-comparison-store";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import { toEditorNode } from "#src/lib/workflow-graph-types";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
} from "#src/lib/workflow-save-store";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";

export const CHANGES_WORKFLOW_ID = "wf_1";

export const EMPTY_CATALOG: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [],
};

/** A persisted action step with a label and no action chosen. */
export function changesStep(id: string, label: string): PersistedWorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label, type: "action" },
  };
}

type Store = ReturnType<typeof createStore>;

/**
 * The server a Changes case talks to: each comparison request's base, answered
 * by `answerComparison` (`payload` by default), and one page of version history.
 */
export function stubComparisonServer(payload: WorkflowComparisonPayload) {
  const server = {
    comparisonRequests: [] as Array<string | undefined>,
    answerComparison: (): Promise<Response> | Response =>
      rpcJsonResponse(payload),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = extractRpcProcedurePath(rpcUrl(url));
      const input = await parseRpcRequestInput(init);
      if (path === "workflow/compareVersion") {
        server.comparisonRequests.push(
          typeof input.baseVersionId === "string"
            ? input.baseVersionId
            : undefined
        );
        return server.answerComparison();
      }
      if (path === "workflow/getVersionHistory") {
        return rpcJsonResponse({
          items: [1, 2, 3].map((version) => ({
            id: `version_${version}`,
            version,
            publishedAt: "2026-09-01T00:00:00.000Z",
            isCurrent: version === 3,
          })),
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected RPC ${path}`);
    })
  );
  return server;
}

/** Install a comparison through the request epochs, as a response does. */
export function installComparison(
  store: Store,
  payload: WorkflowComparisonPayload
) {
  const epoch = store.set(
    beginWorkflowComparisonRequestAtom,
    CHANGES_WORKFLOW_ID
  );
  store.set(installWorkflowComparisonAtom, {
    workflowId: CHANGES_WORKFLOW_ID,
    epoch,
    payload,
  });
  store.set(settleWorkflowComparisonRequestAtom, {
    workflowId: CHANGES_WORKFLOW_ID,
    epoch,
  });
}

/**
 * The comparison canvas as a phone shows it: one control per displayed node,
 * each inspecting its node as a tap on the canvas does.
 */
function ComparisonCanvasNodes() {
  const graph = useAtomValue(comparisonDisplayGraphAtom);
  const inspectNode = useWorkflowNodeInspection();
  return (
    <div data-testid="comparison-canvas">
      {graph?.nodes.map((node) => (
        <button
          className="react-flow__node"
          data-id={node.id}
          key={node.id}
          onClick={() => inspectNode(node.id)}
          type="button"
        >
          {`Canvas ${node.data.label}`}
        </button>
      ))}
    </div>
  );
}

/**
 * Render Canvas Reveal inside the editor route at `search`, over a Draft of
 * `draftNodes`, with `installed` installed as the comparison when it is given.
 * With `mobile`, the mobile Reveal sequence renders over a canvas whose nodes
 * are buttons, or over the real `WorkflowCanvas` with `workflowCanvas`. The route is not synced to the store, so a case that follows a
 * navigation calls `show` with the route's search.
 */
export async function renderChangesReveal(input: {
  search: WorkflowRouteSearch;
  installed: WorkflowComparisonPayload | null;
  draftNodes: readonly PersistedWorkflowNode[];
  catalog?: ExtensionCatalog | undefined;
  mobile?: boolean | undefined;
  workflowCanvas?: boolean | undefined;
}) {
  const { search } = input;
  const store = createStore();
  store.set(loadWorkflowGraphAtom, {
    nodes: input.draftNodes.map(toEditorNode),
    edges: [],
  });
  store.set(currentWorkflowIdAtom, CHANGES_WORKFLOW_ID);
  store.set(currentWorkflowNameAtom, "Appointment reminders");
  showWorkspaceRoute(store, search);
  if (input.installed) {
    installComparison(store, input.installed);
  }

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (value: WorkflowRouteSearch & SearchSchemaInput) =>
      authorizedWorkflowSearch(value, {
        canOpenRuns: true,
        canOpenComparison: true,
      }),
    component: () => (
      <div className="relative" data-testid="canvas-area">
        {input.mobile ? (
          <MobileRevealCovered>
            {input.workflowCanvas ? (
              <WorkflowCanvas canEdit />
            ) : (
              <ComparisonCanvasNodes />
            )}
          </MobileRevealCovered>
        ) : null}
        <CanvasReveal />
        {input.mobile ? <MobileReveal /> : null}
      </div>
    ),
  });
  const query = new URLSearchParams(
    Object.entries(search).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  ).toString();
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [`/workflows/${CHANGES_WORKFLOW_ID}?${query}`],
    }),
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  if (input.workflowCanvas) {
    // The canvas's nodes read the connected integrations.
    queryClient.setQueryData(integrationsQueryOptions().queryKey, []);
  }

  const view = render(
    <ExtensionCatalogProvider value={input.catalog ?? EMPTY_CATALOG}>
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
  await view.findByTestId("canvas-area");
  const aside = () => {
    const element = view.container.querySelector<HTMLElement>(
      '[data-slot="canvas-reveal"]'
    );
    if (!element) {
      throw new Error("Canvas Reveal did not render");
    }
    return element;
  };
  const inReveal = () => within(aside());
  const list = () =>
    aside().querySelector<HTMLElement>('[data-slot="change-list"]');
  const click = (name: string | RegExp) =>
    fireEvent.click(inReveal().getByRole("button", { name }));
  const show = async (next: WorkflowRouteSearch) => {
    await act(async () => {
      showWorkspaceRoute(store, next);
    });
  };
  return {
    view,
    store,
    router,
    queryClient,
    aside,
    inReveal,
    list,
    click,
    show,
  };
}
