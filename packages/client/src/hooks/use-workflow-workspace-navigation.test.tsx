import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider, useSetAtom } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import {
  currentWorkflowIdAtom,
  isWorkflowOwnerAtom,
} from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { enterRunsWorkspaceAtom } from "#src/lib/workflow-workspace-navigation";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function NavigationHost() {
  const navigation = useWorkflowWorkspaceNavigation();
  const otherNavigation = useWorkflowWorkspaceNavigation();
  const setWorkflowId = useSetAtom(currentWorkflowIdAtom);
  const enterRunsDirectly = useSetAtom(enterRunsWorkspaceAtom);
  return (
    <>
      <button onClick={navigation.showChanges} type="button">
        Changes
      </button>
      <button onClick={otherNavigation.showDraft} type="button">
        Draft elsewhere
      </button>
      <button onClick={otherNavigation.showRuns} type="button">
        Runs elsewhere
      </button>
      <button onClick={enterRunsDirectly} type="button">
        Start run directly
      </button>
      <button onClick={() => setWorkflowId("workflow_2")} type="button">
        Workflow 2
      </button>
    </>
  );
}

async function renderNavigationHost() {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(isWorkflowOwnerAtom, true);
  store.set(workflowWorkspaceViewAtom, "runs");
  const navigation = deferred();
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    component: NavigationHost,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: ["/workflows/workflow_1?executionId=run_1"],
    }),
  });

  const view = render(
    <JotaiProvider store={store}>
      <OverlayProvider>
        <RouterProvider router={router} />
      </OverlayProvider>
    </JotaiProvider>
  );
  await view.findByRole("button", { name: "Changes" });
  vi.spyOn(router, "navigate").mockImplementation(
    () => navigation.promise as ReturnType<typeof router.navigate>
  );

  return { navigation, store, view };
}

describe("useWorkflowWorkspaceNavigation", () => {
  it("does not enter Changes after a newer Draft transition", async () => {
    const { navigation, store, view } = await renderNavigationHost();

    fireEvent.click(view.getByRole("button", { name: "Changes" }));
    fireEvent.click(view.getByRole("button", { name: "Draft elsewhere" }));
    await act(async () => navigation.resolve());

    expect(store.get(workflowWorkspaceViewAtom)).toBe("draft");
  });

  it("does not enter Changes after a newer Runs transition", async () => {
    const { navigation, store, view } = await renderNavigationHost();

    fireEvent.click(view.getByRole("button", { name: "Changes" }));
    fireEvent.click(view.getByRole("button", { name: "Runs elsewhere" }));
    await act(async () => navigation.resolve());

    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
  });

  it("does not enter Changes after a direct run transition", async () => {
    const { navigation, store, view } = await renderNavigationHost();

    fireEvent.click(view.getByRole("button", { name: "Changes" }));
    fireEvent.click(view.getByRole("button", { name: "Start run directly" }));
    await act(async () => navigation.resolve());

    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
  });

  it("does not enter Changes in a workflow opened during navigation", async () => {
    const { navigation, store, view } = await renderNavigationHost();

    fireEvent.click(view.getByRole("button", { name: "Changes" }));
    fireEvent.click(view.getByRole("button", { name: "Workflow 2" }));
    await act(async () => navigation.resolve());

    expect(store.get(currentWorkflowIdAtom)).toBe("workflow_2");
    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
  });
});
