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
import { createStore, Provider as JotaiProvider } from "jotai";
import { describe, expect, it } from "vitest";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import {
  loadWorkflowGraphAtom,
  selectedNodeAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import {
  isSidebarCollapsedAtom,
  selectedExecutionIdAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";

function SwitcherHost() {
  const navigation = useWorkflowWorkspaceNavigation();
  return (
    <>
      <WorkspaceRouteSync />
      <button onClick={navigation.showDraft} type="button">
        Draft
      </button>
      <button onClick={navigation.showRuns} type="button">
        Runs
      </button>
    </>
  );
}

async function renderSwitcher(initialEntry: string) {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(loadWorkflowGraphAtom, {
    nodes: [
      {
        id: "draft_step",
        type: "action",
        position: { x: 0, y: 0 },
        data: { label: "Draft step", type: "action" },
      },
    ],
    edges: [],
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/workflows/$workflowId",
        validateSearch: (search: WorkflowRouteSearch & SearchSchemaInput) =>
          authorizedWorkflowSearch(search, {
            canOpenRuns: true,
            canOpenComparison: true,
          }),
        component: SwitcherHost,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <JotaiProvider store={store}>
        <OverlayProvider>
          <RouterProvider router={router} />
        </OverlayProvider>
      </JotaiProvider>
    </QueryClientProvider>
  );
  await view.findByRole("button", { name: "Runs" });
  const click = (name: string) =>
    fireEvent.click(view.getByRole("button", { name }));
  return { store, router, click };
}

describe("useWorkflowWorkspaceNavigation", () => {
  it("returns each view to the search, selection, and Reveal it was left with", async () => {
    const { store, router, click } = await renderSwitcher(
      "/workflows/workflow_1"
    );
    act(() => {
      store.set(selectOnlyNodeAtom, "draft_step");
      store.set(isSidebarCollapsedAtom, true);
    });

    click("Runs");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: "runs" })
    );
    // A first visit opens the inspector for that view alone.
    expect(store.get(isSidebarCollapsedAtom)).toBe(false);
    await act(() =>
      router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "workflow_1" },
        search: { view: "runs", executionId: "run_1" },
      })
    );
    act(() => store.set(selectOnlyNodeAtom, "run_step"));

    click("Draft");
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(store.get(workflowWorkspaceViewAtom)).toBe("draft");
    expect(store.get(selectedNodeAtom)).toBe("draft_step");
    expect(store.get(isSidebarCollapsedAtom)).toBe(true);

    click("Runs");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        view: "runs",
        executionId: "run_1",
      })
    );
    expect(store.get(selectedExecutionIdAtom)).toBe("run_1");
    expect(store.get(selectedNodeAtom)).toBe("run_step");
    expect(store.get(isSidebarCollapsedAtom)).toBe(false);
  });

  it("opens a first-visit inspector without writing the cookie", async () => {
    const { store, router, click } = await renderSwitcher(
      "/workflows/workflow_1"
    );
    const cookie = document.cookie;

    click("Runs");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: "runs" })
    );

    expect(store.get(isSidebarCollapsedAtom)).toBe(false);
    expect(document.cookie).toBe(cookie);
  });

  it("pushes a history entry so Back returns to the workspace left", async () => {
    const { router, click } = await renderSwitcher(
      "/workflows/workflow_1?view=runs"
    );
    const entries = router.history.length;

    click("Draft");
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.history.length).toBe(entries + 1);

    await act(async () => router.history.back());
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: "runs" })
    );
  });
});
