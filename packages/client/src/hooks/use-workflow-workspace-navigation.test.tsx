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
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { ConfigurationOverlay } from "#src/components/overlays/configuration-overlay";
import {
  OverlayProvider,
  useOverlay,
} from "#src/components/overlays/overlay-provider";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
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
  activeDesktopRevealLevelAtom,
  activeMobileSheetsAtom,
  activeWorkspaceAddressAtom,
  setWorkspaceRevealLevelAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  selectedExecutionIdAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";

/**
 * The overlays on the stack, each mounted as the overlay container would, and
 * named by a probe so a case can tell which surface is on screen.
 */
function OverlayStack() {
  const { stack } = useOverlay();
  return (
    <>
      {stack.map(({ id, component: Overlay, props }) => (
        <div data-testid={`overlay:${Overlay.name}`} key={id}>
          <Overlay overlayId={id} {...props} />
        </div>
      ))}
    </>
  );
}

/** The viewport happy-dom answers the `md` media query from. */
function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

function SwitcherHost() {
  const navigation = useWorkflowWorkspaceNavigation();
  const { openSheet } = useConfigurationSheet();
  return (
    <>
      <WorkspaceRouteSync />
      <OverlayStack />
      <button onClick={() => openSheet()} type="button">
        Configuration
      </button>
      <button onClick={navigation.showDraft} type="button">
        Draft
      </button>
      <button onClick={navigation.showRuns} type="button">
        Runs
      </button>
      <button onClick={navigation.showChanges} type="button">
        Changes
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
    <ExtensionCatalogProvider
      value={{ entities: [], integrations: [], actions: [], events: [] }}
    >
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <JotaiProvider store={store}>
          <OverlayProvider>
            <RouterProvider router={router} />
          </OverlayProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );
  await view.findByRole("button", { name: "Runs" });
  const click = (name: string) =>
    fireEvent.click(view.getByRole("button", { name }));
  return { store, router, click, view };
}

describe("useWorkflowWorkspaceNavigation", () => {
  it("returns each view to the search, selection, and Reveal it was left with", async () => {
    const { store, router, click } = await renderSwitcher(
      "/workflows/workflow_1"
    );
    act(() => {
      store.set(selectOnlyNodeAtom, "draft_step");
      store.set(setWorkspaceRevealLevelAtom, {
        address: store.get(activeWorkspaceAddressAtom),
        level: "closed",
      });
    });

    click("Runs");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: "runs" })
    );
    // A first visit opens the inspector for that view alone.
    expect(store.get(activeDesktopRevealLevelAtom)).toBe("browse");
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
    expect(store.get(activeDesktopRevealLevelAtom)).toBe("closed");

    click("Runs");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        view: "runs",
        executionId: "run_1",
      })
    );
    expect(store.get(selectedExecutionIdAtom)).toBe("run_1");
    expect(store.get(selectedNodeAtom)).toBe("run_step");
    expect(store.get(activeDesktopRevealLevelAtom)).toBe("browse");
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

    expect(store.get(activeDesktopRevealLevelAtom)).toBe("browse");
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

  describe("below md", () => {
    afterEach(() => setViewportWidth(1440));

    it("opens the Runs and Changes address sheets over a Draft sheet, and shows the Draft sheet again on return to Draft", async () => {
      setViewportWidth(390);
      const { store, router, click, view } = await renderSwitcher(
        "/workflows/workflow_1"
      );
      const configurationSheet = () =>
        view.queryByTestId(`overlay:${ConfigurationOverlay.name}`);
      act(() => store.set(selectOnlyNodeAtom, "draft_step"));
      expect(
        store.get(activeMobileSheetsAtom).map((sheet) => sheet.level)
      ).toEqual(["summary"]);

      click("Runs");
      await waitFor(() =>
        expect(router.state.location.search).toEqual({ view: "runs" })
      );
      expect(configurationSheet()).toBeNull();
      expect(store.get(activeMobileSheetsAtom)).toEqual([
        {
          level: "summary",
          inspected: null,
          scroll: 0,
          section: null,
        },
      ]);

      click("Changes");
      await waitFor(() =>
        expect(store.get(workflowWorkspaceViewAtom)).toBe("changes")
      );
      await waitFor(() =>
        expect(store.get(activeMobileSheetsAtom)).toMatchObject([
          { level: "summary", inspected: null, section: null },
        ])
      );
      expect(configurationSheet()).toBeNull();

      click("Draft");
      await waitFor(() => expect(router.state.location.search).toEqual({}));
      expect(configurationSheet()).toBeNull();
      expect(store.get(selectedNodeAtom)).toBe("draft_step");
      expect(
        store.get(activeMobileSheetsAtom).map((sheet) => sheet.level)
      ).toEqual(["summary"]);
    });

    it("closes the configuration sheet of a Draft with nothing selected when the view becomes Changes, where the comparison summary sheet shows", async () => {
      setViewportWidth(390);
      const { store, click, view } = await renderSwitcher(
        "/workflows/workflow_1"
      );
      const configurationSheet = () =>
        view.queryByTestId(`overlay:${ConfigurationOverlay.name}`);

      click("Configuration");
      await waitFor(() => expect(configurationSheet()).not.toBeNull());

      click("Changes");
      await waitFor(() =>
        expect(store.get(workflowWorkspaceViewAtom)).toBe("changes")
      );
      await waitFor(() => expect(configurationSheet()).toBeNull());
      expect(
        store.get(activeMobileSheetsAtom).map((sheet) => sheet.inspected)
      ).toEqual([null]);
    });
  });
});
