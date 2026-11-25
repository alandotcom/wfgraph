import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { describe, expect, it } from "vitest";
import {
  workflowLoadErrorAtom,
  workflowNotFoundAtom,
} from "#src/lib/workflow-save-store";
import WorkflowEditor from "#src/routes/workflows/[workflowId]/page";

async function renderMissingWorkflow(
  arrange: (store: ReturnType<typeof createStore>) => void = (store) =>
    store.set(workflowNotFoundAtom, true)
) {
  const store = createStore();
  arrange(store);
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const editorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    component: WorkflowEditor,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <p>Workflows</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, editorRoute]),
    history: createMemoryHistory({ initialEntries: ["/workflows/missing"] }),
  });
  await router.load();
  return render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>
  );
}

describe("WorkflowEditor for a workflow that does not exist", () => {
  // The editor's toolbar, status strip and canvas would describe a workflow
  // that does not exist, so the page shows the not-found state alone.
  it("shows the not-found state with no editor chrome around it", async () => {
    const view = await renderMissingWorkflow();

    expect(
      await view.findByRole("heading", { name: "Workflow not found" })
    ).toBeTruthy();
    expect(
      view.getByRole("link", { name: "Go to Workflows" }).getAttribute("href")
    ).toBe("/");
    expect(view.queryByRole("toolbar")).toBeNull();
    expect(view.queryByRole("button", { name: /Publish/ })).toBeNull();
    expect(view.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(view.queryByText("Saved")).toBeNull();
  });
});

describe("WorkflowEditor for a workflow that failed to load", () => {
  // Nothing was loaded, so no editor chrome may describe a workflow: no
  // title, no outline or details, and no save state.
  it("shows the failure with Try again and Go to Workflows, and no editor chrome", async () => {
    const view = await renderMissingWorkflow((store) =>
      store.set(workflowLoadErrorAtom, "The workflow could not be loaded.")
    );

    expect(
      await view.findByRole("heading", { name: "Couldn't load workflow" })
    ).toBeTruthy();
    expect(view.getByText("The workflow could not be loaded.")).toBeTruthy();
    expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(
      view.getByRole("link", { name: "Go to Workflows" }).getAttribute("href")
    ).toBe("/");
    expect(view.queryByRole("toolbar")).toBeNull();
    expect(view.queryByText("Untitled workflow")).toBeNull();
    expect(view.queryByText(/no steps yet/)).toBeNull();
    expect(view.queryByText(/no issues/)).toBeNull();
    expect(view.queryByText("Saved")).toBeNull();
    expect(document.title).toMatch(/^Couldn't load workflow/);
  });
});
