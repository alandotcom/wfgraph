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
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import {
  canvasEditingLockedAtom,
  executionOverlayGraphAtom,
} from "#src/lib/workflow-graph-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { workflowWorkspaceView } from "#src/lib/workflow-route-state";

/**
 * The sheet's dismissal contract, driven through the real `OverlayProvider`
 * rather than a rendered sheet.
 *
 * What is under test is which close paths reach the `onClose` this hook
 * registers, and the provider is what decides that: the header button and the
 * drawer's own dismiss call `closeAll`, Escape calls `pop`, and every one of
 * them fires the same callback. Mounting `NodeConfigPanel` to press its X would
 * add an extension catalog and a node selection to each case and measure the
 * same one callback.
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

/** Any other overlay, standing in for Test Run or a delete confirmation. */
function OtherOverlay() {
  return null;
}

/**
 * Buttons rather than callbacks captured out of render: assigning to an object
 * declared outside the component is what `react-hooks-js(immutability)` refuses,
 * and clicking is how each of these fires in the app anyway.
 */
function Host() {
  const { openSheet } = useConfigurationSheet();
  const { open, closeAll, pop } = useOverlay();

  return (
    <>
      <button data-testid="open-sheet" onClick={openSheet} type="button" />
      <button
        data-testid="open-other"
        onClick={() => open(OtherOverlay, {})}
        type="button"
      />
      <button data-testid="close-all" onClick={closeAll} type="button" />
      <button data-testid="pop" onClick={pop} type="button" />
    </>
  );
}

async function renderSheetHost() {
  const store = createStore();
  store.set(workflowWorkspaceViewAtom, "runs");
  pinRun(store);

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
    // Mirrors the production route, so a case can tell an exit that clears the
    // run apart from one the router would put straight back.
    beforeLoad: ({ search }) => {
      const tab = workflowWorkspaceView(search.executionId);
      if (tab !== null) {
        store.set(workflowWorkspaceViewAtom, tab);
      }
    },
    component: () => <Host />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: ["/workflows/wf_1?executionId=exec_1"],
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

  return { store, router, click };
}

describe("useConfigurationSheet", () => {
  afterEach(() => {
    setViewportWidth(1024);
  });

  // The workspace switcher is how a narrow viewport reaches the open run,
  // so closing it has to take the run off the canvas as well. Left pinned, the
  // canvas refused every edit with no panel on screen to say why (#96).
  it("preserves the open run when the sheet is dismissed", async () => {
    setViewportWidth(500);
    const { store, router, click } = await renderSheetHost();

    await click("open-sheet");
    expect(store.get(canvasEditingLockedAtom)).toBe(true);

    await click("close-all");

    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
    expect(router.state.location.search).toEqual({ executionId: "exec_1" });
    expect(store.get(canvasEditingLockedAtom)).toBe(true);
  });

  // Escape leaves through `pop` rather than `closeAll`; both have to arrive at
  // the same place, or the bug survives on whichever path was missed.
  it("preserves the open run when the sheet is popped", async () => {
    setViewportWidth(500);
    const { store, router, click } = await renderSheetHost();

    await click("open-sheet");
    await click("pop");

    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
    expect(router.state.location.search).toEqual({ executionId: "exec_1" });
  });

  // Opening another overlay replaces the stack rather than stacking on it, so
  // the sheet is gone from screen without anything having dismissed it. Tapping
  // Test Run from the sheet is the reachable case.
  it("preserves the open run when another overlay takes the stack", async () => {
    setViewportWidth(500);
    const { store, router, click } = await renderSheetHost();

    await click("open-sheet");
    await click("open-other");

    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
    expect(router.state.location.search).toEqual({ executionId: "exec_1" });
    expect(store.get(canvasEditingLockedAtom)).toBe(true);
  });

  // Widening past the rail's breakpoint also closes the sheet, and there the
  // rail has taken the same run over. Exiting then would drop a run the user is
  // still looking at.
  it("keeps the run when the sheet gives way to a rail", async () => {
    setViewportWidth(500);
    const { store, router, click } = await renderSheetHost();

    await click("open-sheet");

    setViewportWidth(1200);
    await click("close-all");

    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
    expect(router.state.location.search).toEqual({ executionId: "exec_1" });
    expect(store.get(canvasEditingLockedAtom)).toBe(true);
  });
});
