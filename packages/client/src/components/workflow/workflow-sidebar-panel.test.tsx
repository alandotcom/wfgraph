import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { WorkflowSidebarPanel } from "#src/components/workflow/workflow-sidebar-panel";
import {
  canvasEditingLockedAtom,
  executionOverlayGraphAtom,
} from "#src/lib/workflow-graph-store";
import { isWorkflowOwnerAtom } from "#src/lib/workflow-save-store";
import { workflowPanelTab } from "#src/lib/workflow-route-state";
import {
  isSidebarCollapsedAtom,
  propertiesPanelActiveTabAtom,
} from "#src/lib/workflow-ui-store";
import {
  answerWorkflowRunRpc,
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcUrl,
  type WorkflowRunRpcFixture,
} from "#src/lib/rpc-fetch-test-support";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const emptyCatalog: ExtensionCatalog = {
  events: [],
  actions: [],
  integrations: [],
};

/** What the run panel's procedures read. The tests here only open the tab. */
const served: WorkflowRunRpcFixture = {
  items: [],
  supersededCount: 0,
  graphs: {},
  logsSummaryExtras: {},
};

/**
 * The Runs tab opens on a pinned run, so four oRPC procedures fire on render.
 * Without this the queries reach happy-dom's own origin and Node answers each
 * one with an unattributed ECONNRESET after the test has finished.
 */
function stubRunQueries(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = rpcUrl(input);
      const procedurePath = extractRpcProcedurePath(url);
      if (!procedurePath.startsWith("workflow/")) {
        throw new Error(`unexpected fetch in sidebar panel test: ${url}`);
      }

      return answerWorkflowRunRpc(
        served,
        procedurePath,
        await parseRpcRequestInput(init)
      );
    })
  );
}

function renderPanel() {
  const store = createStore();
  store.set(isWorkflowOwnerAtom, true);
  store.set(propertiesPanelActiveTabAtom, "runs");
  store.set(isSidebarCollapsedAtom, false);
  store.set(executionOverlayGraphAtom, {
    nodes: [
      {
        id: "v1_lifecycle",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: "v1_lifecycle", type: "lifecycle" },
      },
    ],
    edges: [],
  });

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: { executionId?: string } & SearchSchemaInput) => ({
      executionId:
        typeof search.executionId === "string" && search.executionId.length > 0
          ? search.executionId
          : undefined,
    }),
    beforeLoad: ({ search }) => {
      const tab = workflowPanelTab(search.executionId);
      if (tab !== null) {
        store.set(propertiesPanelActiveTabAtom, tab);
      }
    },
    component: () => <WorkflowSidebarPanel />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: ["/workflows/wf_1?executionId=exec_1"],
    }),
  });

  const view = render(
    <JotaiProvider store={store}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ExtensionCatalogProvider value={emptyCatalog}>
          <OverlayProvider>
            <RouterProvider router={router} />
          </OverlayProvider>
        </ExtensionCatalogProvider>
      </QueryClientProvider>
    </JotaiProvider>
  );

  return { view, store, router };
}

describe("WorkflowSidebarPanel", () => {
  beforeEach(stubRunQueries);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Collapsing slides the rail behind the viewport edge without unmounting it,
  // so the Runs tab kept its state while its tab bar was out of reach: the run
  // stayed pinned to the canvas and every edit was refused with nothing on
  // screen saying why. Same shape as the mobile sheet in #96.
  it("closes the open run when the rail is collapsed", async () => {
    const { view, store, router } = renderPanel();

    await waitFor(() => {
      expect(view.getByLabelText("Collapse panel")).toBeTruthy();
    });
    expect(store.get(canvasEditingLockedAtom)).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByLabelText("Collapse panel"));
    });

    expect(store.get(isSidebarCollapsedAtom)).toBe(true);
    expect(store.get(propertiesPanelActiveTabAtom)).toBe("properties");
    expect(router.state.location.search).toEqual({});
    expect(store.get(canvasEditingLockedAtom)).toBe(false);
  });

  // Cmd+B is the other way to collapse, and a shortcut that skipped the exit
  // would leave the same locked canvas the button no longer can.
  it("closes the open run when the collapse shortcut is pressed", async () => {
    const { view, store, router } = renderPanel();

    await waitFor(() => {
      expect(view.getByLabelText("Collapse panel")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });

    expect(store.get(isSidebarCollapsedAtom)).toBe(true);
    expect(store.get(propertiesPanelActiveTabAtom)).toBe("properties");
    expect(router.state.location.search).toEqual({});
  });

  // Expanding is not an exit. The same handler runs, and reading the collapse
  // flag the wrong way round would close a run every time the rail came back.
  it("keeps the run when the rail is expanded again", async () => {
    const { view, store, router } = renderPanel();

    await waitFor(() => {
      expect(view.getByLabelText("Collapse panel")).toBeTruthy();
    });

    // Inside act, so the rail has re-rendered against the collapsed value
    // before the shortcut reads it. Set outside, the handler would still hold
    // the expanded value and the keypress would collapse a second time.
    await act(async () => {
      store.set(isSidebarCollapsedAtom, true);
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });

    expect(store.get(isSidebarCollapsedAtom)).toBe(false);
    expect(store.get(propertiesPanelActiveTabAtom)).toBe("runs");
    expect(router.state.location.search).toEqual({ executionId: "exec_1" });
  });
});
