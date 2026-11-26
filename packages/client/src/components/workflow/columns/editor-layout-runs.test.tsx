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
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  execution,
  installRunsRevealRpc,
  labelledGraph,
  log,
  removeRunsRevealRpc,
  runHeading,
  served,
} from "#src/components/workflow/canvas-reveal/runs-reveal.test-support";
import { DetailsPanel } from "#src/components/workflow/details/details-panel";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { OutlineColumn } from "#src/components/workflow/outline/outline-column";
import { RunStoppedStepSelection } from "#src/components/workflow/outline/run-stopped-step";
import { RunStatusProjection } from "#src/components/workflow/run-status-projection";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
} from "#src/lib/workflow-save-store";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { outlineHiddenAtom } from "./editor-columns-store";
import { EditorLayout } from "./editor-layout";

beforeEach(() => {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width: 1440 });
  installRunsRevealRpc();
});
afterEach(removeRunsRevealRpc);

/**
 * The editor below the toolbar in Runs, as the page assembles it: the run
 * list or run outline floating over a stand-in canvas, and the Inspector.
 */
async function renderEditorInRuns(input: {
  search: WorkflowRouteSearch;
  outlineHidden?: boolean;
}) {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes: [], edges: [] });
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(currentWorkflowNameAtom, "Appointment reminders");
  store.set(outlineHiddenAtom, input.outlineHidden === true);
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: WorkflowRouteSearch & SearchSchemaInput) =>
      authorizedWorkflowSearch(search, { canOpenRuns: true, canReview: true }),
    component: () => (
      <>
        <ExecutionOverlaySync />
        <WorkspaceRouteSync />
        <RunStatusProjection />
        <RunStoppedStepSelection />
        <EditorLayout
          canvas={<div data-testid="canvas" />}
          details={<DetailsPanel />}
          outline={<OutlineColumn />}
        />
      </>
    ),
  });
  const query = new URLSearchParams(
    Object.entries(input.search).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  ).toString();
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [`/workflows/wf_1${query ? `?${query}` : ""}`],
    }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ExtensionCatalogProvider value={emptyExtensionCatalog}>
          <IntegrationUiProvider value={{}}>
            <ReactFlowProvider>
              <OverlayProvider>
                <RouterProvider router={router} />
              </OverlayProvider>
            </ReactFlowProvider>
          </IntegrationUiProvider>
        </ExtensionCatalogProvider>
      </QueryClientProvider>
    </JotaiProvider>
  );
  await view.findByTestId("canvas");
  const inspector = () =>
    view.container.querySelector<HTMLElement>('[data-slot="details-float"]');
  const title = () =>
    inspector()?.querySelector('[data-slot="reveal-title"]')?.textContent ??
    undefined;
  const floatingOutline = () =>
    view.container.querySelector<HTMLElement>('[data-slot="floating-outline"]');
  const rows = () => view.queryAllByTestId("workflow-run-summary-row");
  const show = async (next: WorkflowRouteSearch) => {
    await act(async () => {
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: next,
      });
    });
  };
  return { view, store, router, inspector, title, floatingOutline, rows, show };
}

/** Two steps in a row, as one run's pinned graph. */
function twoSteps() {
  return labelledGraph(
    [
      { id: "confirm", label: "Send confirmation" },
      { id: "receipt", label: "Send receipt" },
    ],
    undefined,
    [["confirm", "receipt"]]
  );
}

/** A failed run whose second step failed. */
function serveFailedRun(id: string) {
  served.items = [execution(id, "failed")];
  served.graphs = { [`ver_${id}`]: twoSteps() };
  served.logsByExecutionId = {
    [id]: [
      log({
        id: "log_confirm",
        nodeId: "confirm",
        nodeName: "Send confirmation",
        status: "success",
      }),
      log({
        id: "log_receipt",
        nodeId: "receipt",
        nodeName: "Send receipt",
        status: "error",
        error: "invalid_auth",
        startedAt: "2026-03-01T10:00:05.000Z",
      }),
    ],
  };
}

describe("EditorLayout in Runs", () => {
  it("shows the run list with no Inspector, and the open run in the Inspector", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    const { inspector, title, rows, floatingOutline, show } =
      await renderEditorInRuns({ search: { view: "runs" } });

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(floatingOutline()?.contains(rows()[0] ?? null)).toBe(true);
    expect(inspector()?.dataset.open).toBe("false");

    await show({ view: "runs", executionId: "exec_b" });
    await waitFor(() => expect(inspector()?.dataset.open).toBe("true"));
    await waitFor(() => expect(title()).toBe(runHeading("exec_b")));
  });

  it("opens a failed run on the step that failed, with its row selected", async () => {
    serveFailedRun("exec_f");
    const { view, store, title, floatingOutline } = await renderEditorInRuns({
      search: { view: "runs", executionId: "exec_f" },
    });

    await waitFor(() =>
      expect(store.get(activeSelectionAtom).nodeIds).toEqual(["receipt"])
    );
    await waitFor(() => expect(title()).toBe("Send receipt"));
    expect(floatingOutline()?.textContent).toContain(runHeading("exec_f"));
    expect(
      view
        .getAllByRole("treeitem")
        .find((row) => row.textContent?.includes("Send receipt"))
        ?.getAttribute("aria-selected")
    ).toBe("true");
  });

  it("opens a failed run on the step that failed while the outline is hidden", async () => {
    serveFailedRun("exec_f");
    const { store, title, floatingOutline } = await renderEditorInRuns({
      search: { view: "runs", executionId: "exec_f" },
      outlineHidden: true,
    });

    await waitFor(() =>
      expect(store.get(activeSelectionAtom).nodeIds).toEqual(["receipt"])
    );
    await waitFor(() => expect(title()).toBe("Send receipt"));
    expect(floatingOutline()).toBeNull();
  });

  it("brings back the hidden run list on Back from a run, with focus on that run's row", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    const { view, title, rows, floatingOutline } = await renderEditorInRuns({
      search: { view: "runs", executionId: "exec_b" },
      outlineHidden: true,
    });
    await waitFor(() => expect(title()).toBe(runHeading("exec_b")));
    expect(floatingOutline()).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(floatingOutline()).not.toBeNull();
    // The list is newest first, so exec_b's row is the first.
    await waitFor(() =>
      expect(
        document.activeElement?.closest(
          '[data-testid="workflow-run-summary-row"]'
        )
      ).toBe(rows()[0])
    );
  });
});
