import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import { act, fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import {
  OverlayProvider,
  useOverlay,
} from "#src/components/overlays/overlay-provider";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import {
  canvasEditingLockedAtom,
  executionOverlayGraphAtom,
} from "#src/lib/workflow-graph-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { activeMobileSheetsAtom } from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";

/**
 * Which inspector a narrow viewport opens for the active address. A run opens
 * its address sheet in the mobile Reveal sequence, which the navigation state
 * records, and no overlay goes on the stack.
 */

/** A run pinned to the canvas, which is what holds editing locked. */
function pinRun(store: ReturnType<typeof createStore>): void {
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
}

/**
 * The viewport itself rather than `window.innerWidth` alone, because the width
 * is read through a media query: `useIsMobile` asks `matchMedia` for Tailwind's
 * `md` breakpoint, and happy-dom answers that from its own viewport, which an
 * assignment to `innerWidth` does not touch.
 */
function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

/**
 * Buttons rather than callbacks captured out of render: assigning to an object
 * declared outside the component is what `react-hooks-js(immutability)` refuses,
 * and clicking is how each of these fires in the app anyway.
 */
function Host() {
  const { openSheet } = useConfigurationSheet();
  const { hasOverlays } = useOverlay();

  return (
    <>
      <button
        data-testid="open-sheet"
        onClick={() => openSheet()}
        type="button"
      />
      <output data-testid="overlays">{String(hasOverlays)}</output>
    </>
  );
}

async function renderSheetHost() {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");
  // The route this harness opens, applied as `WorkspaceRouteSync` would.
  showWorkspaceRoute(store, { view: "runs", executionId: "exec_1" });
  pinRun(store);

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: WorkflowRouteSearch & SearchSchemaInput) =>
      authorizedWorkflowSearch(search, {
        canOpenRuns: true,
        canOpenComparison: true,
      }),
    component: () => <Host />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: ["/workflows/wf_1?view=runs&executionId=exec_1"],
    }),
  });

  const view = render(
    <JotaiProvider store={store}>
      <OverlayProvider>
        <RouterProvider router={router} />
      </OverlayProvider>
    </JotaiProvider>
  );

  // The router resolves the route after render returns, so nothing below can
  // click until the host is actually on screen.
  const click = async (testId: string) => {
    const button = await view.findByTestId(testId);
    await act(async () => {
      fireEvent.click(button);
    });
  };

  return { store, router, click, view };
}

describe("useConfigurationSheet", () => {
  afterEach(() => {
    setViewportWidth(1024);
  });

  it("opens a run's address sheet in place of the configuration sheet and keeps the run", async () => {
    setViewportWidth(500);
    const { store, router, click, view } = await renderSheetHost();

    await click("open-sheet");

    expect(view.getByTestId("overlays").textContent).toBe("false");
    expect(
      store.get(activeMobileSheetsAtom).map((sheet) => sheet.inspected)
    ).toEqual([null]);
    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
    expect(router.state.location.search).toEqual({
      view: "runs",
      executionId: "exec_1",
    });
    expect(store.get(canvasEditingLockedAtom)).toBe(true);
  });
});
