import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  extractRpcProcedurePath,
  rpcErrorResponse,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import { orpcQuery } from "#src/lib/rpc-query";
import WorkflowsPage from "#src/routes/workflows/page";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_SENTENCE = "Runs are deleted 30 days after they finish.";

/** Serves the two reads the dashboard makes, with the All Runs page naming `runRetentionMs`. */
function stubDashboardRpc(
  runRetentionMs: number | null,
  workflows: readonly object[] = []
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const procedurePath = extractRpcProcedurePath(rpcUrl(input));
      switch (procedurePath) {
        case "workflow/getAll":
          return rpcJsonResponse(workflows);
        case "workflow/getExecutionsGlobal":
          return rpcJsonResponse({
            items: [],
            observedAt: "2026-03-01T10:00:00.000Z",
            overdueAfterMs: 60_000,
            runRetentionMs,
            nextCursor: null,
          });
        default:
          throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      }
    })
  );
}

/** Refuses both reads the dashboard makes, as a server that is down would. */
function stubFailingDashboardRpc() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      rpcErrorResponse({
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
        message: "Internal server error",
      })
    )
  );
}

async function renderWorkflowsPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: WorkflowsPage,
  });
  // The editor route renders a marker, so a test can see where a click went.
  const editorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    component: () => <p>Editor</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute, editorRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = render(
    <ExtensionCatalogProvider
      value={{ entities: [], events: [], actions: [], integrations: [] }}
    >
      <QueryClientProvider client={queryClient}>
        <OverlayProvider>
          <RouterProvider router={router} />
        </OverlayProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );
  return { view, queryClient, router };
}

describe("WorkflowsPage run retention note", () => {
  beforeEach(() => {
    installAuthorizationGrantsForTests(WfGraphOperationIds);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAuthorizationGrantsForTests();
  });

  it("shows the host's window on the All Runs list once the first page carries it", async () => {
    stubDashboardRpc(THIRTY_DAYS_MS);
    const { view } = await renderWorkflowsPage();

    expect(await view.findByText(RETENTION_SENTENCE)).toBeTruthy();
  });

  it("stays hidden when the first page carries no window", async () => {
    stubDashboardRpc(null);
    const { view, queryClient } = await renderWorkflowsPage();

    // Absence only means something once the first page has been answered.
    await waitFor(() =>
      expect(
        queryClient
          .getQueryCache()
          .findAll({ queryKey: orpcQuery.workflow.getExecutionsGlobal.key() })
          .map((query) => query.state.status)
      ).toEqual(["success"])
    );
    expect(
      view.getByText("Combined run history across workflows.")
    ).toBeTruthy();
    expect(view.queryByText(/Runs are deleted/)).toBeNull();
  });
});

describe("WorkflowsPage workflow list", () => {
  beforeEach(() => {
    installAuthorizationGrantsForTests(WfGraphOperationIds);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAuthorizationGrantsForTests();
  });

  function summary(
    id: string,
    name: string,
    publishedVersionId?: string,
    overrides: { isPaused?: boolean; mode?: "live" | "test" } = {}
  ) {
    return omitUndefined({
      id,
      name,
      isPaused: overrides.isPaused ?? false,
      mode: overrides.mode ?? "live",
      visibility: "private",
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:00:00.000Z",
      publishedVersionId,
    });
  }

  it("states one status per workflow, and a mode only once a version exists", async () => {
    stubDashboardRpc(null, [
      summary("workflow_1", "Draft only"),
      summary("workflow_2", "Running", "version_1"),
      summary("workflow_3", "Rehearsal", "version_2", { mode: "test" }),
      summary("workflow_4", "On hold", "version_3", { isPaused: true }),
    ]);
    const { view } = await renderWorkflowsPage();

    const rowText = async (name: string) =>
      (await view.findByText(name)).closest("tr")?.textContent ?? "";

    // A Published mode of Live beside "Never published" read as sending.
    expect(await rowText("Draft only")).toContain("Never published");
    expect(await rowText("Draft only")).not.toContain("Live");
    expect(await rowText("Running")).toContain("Live");
    expect(await rowText("Rehearsal")).toContain("Test");
    expect(await rowText("On hold")).toContain("Paused");
    expect(await rowText("On hold")).not.toContain("Live");
    expect(
      view.queryByRole("columnheader", { name: "Published mode" })
    ).toBeNull();
  });

  it("offers Pause only for a workflow that has a published version", async () => {
    stubDashboardRpc(null, [
      summary("workflow_1", "Draft only"),
      summary("workflow_2", "Running", "version_1"),
    ]);
    const { view } = await renderWorkflowsPage();

    const menuItems = async (name: string) => {
      fireEvent.click(
        await view.findByRole("button", { name: `Actions for ${name}` })
      );
      const items = (await view.findAllByRole("menuitem")).map(
        (item) => item.textContent
      );
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });
      await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
      return items;
    };

    expect(await menuItems("Draft only")).not.toContain("Pause");
    expect(await menuItems("Running")).toContain("Pause");
  });
});

describe("WorkflowsPage structure and states", () => {
  beforeEach(() => {
    installAuthorizationGrantsForTests(WfGraphOperationIds);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAuthorizationGrantsForTests();
  });

  const workflow = (id: string, name: string) =>
    omitUndefined({
      id,
      name,
      isPaused: false,
      mode: "live",
      visibility: "private",
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:00:00.000Z",
      publishedVersionId: undefined,
    });

  it("names the page with a level-one heading, a main landmark and the tab title", async () => {
    stubDashboardRpc(null);
    const { view } = await renderWorkflowsPage();

    expect(
      view.getByRole("heading", { level: 1, name: "Workflows" })
    ).toBeTruthy();
    expect(view.getByRole("main")).toBeTruthy();
    await waitFor(() =>
      expect(document.title).toBe("Workflows · Workflow Graph")
    );
  });

  it("says a failed load failed and offers Retry in each panel", async () => {
    stubFailingDashboardRpc();
    const { view } = await renderWorkflowsPage();

    expect(
      await view.findByText("Workflows could not be loaded.")
    ).toBeTruthy();
    expect(await view.findByText("Runs could not be loaded.")).toBeTruthy();
    expect(view.queryByText("No workflows found.")).toBeNull();
    expect(view.queryByText("No runs found.")).toBeNull();
    expect(view.getAllByRole("button", { name: "Retry" })).toHaveLength(2);
  });

  it("names each row's menu after its workflow and keeps the id out of the row", async () => {
    stubDashboardRpc(null, [workflow("workflow_1", "Welcome email")]);
    const { view } = await renderWorkflowsPage();

    const row = (await view.findByText("Welcome email")).closest("tr");
    if (!row) {
      throw new Error("expected the workflow row");
    }
    expect(
      within(row).getByRole("button", { name: "Actions for Welcome email" })
    ).toBeTruthy();
    expect(row.textContent).not.toContain("workflow_1");
  });

  it("opens the workflow from anywhere on its row, with the name as a real link", async () => {
    stubDashboardRpc(null, [workflow("workflow_1", "Welcome email")]);
    const { view, router } = await renderWorkflowsPage();

    const link = await view.findByRole("link", { name: "Welcome email" });
    expect(link.getAttribute("href")).toBe("/workflows/workflow_1");

    const row = link.closest("tr");
    const stateCell = row?.querySelectorAll("td")[2];
    if (!stateCell) {
      throw new Error("expected the state cell");
    }
    fireEvent.click(stateCell);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/workflows/workflow_1")
    );
  });

  it("leaves the row in place when its checkbox is ticked", async () => {
    stubDashboardRpc(null, [workflow("workflow_1", "Welcome email")]);
    const { view, router } = await renderWorkflowsPage();

    fireEvent.click(
      await view.findByRole("checkbox", { name: "Select Welcome email" })
    );
    expect(router.state.location.pathname).toBe("/");
  });

  it("makes the workflow table one Tab stop that the list keys move through", async () => {
    stubDashboardRpc(null, [
      workflow("workflow_1", "Welcome email"),
      workflow("workflow_2", "Renewal reminder"),
    ]);
    const { view, router } = await renderWorkflowsPage();

    await view.findByText("Renewal reminder");
    const rows = () =>
      Array.from(
        view.container.querySelectorAll<HTMLElement>("tbody tr[data-row-index]")
      );
    const [first, second] = rows();
    if (!first || !second) {
      throw new Error("expected two workflow rows");
    }
    expect(rows().map((row) => row.tabIndex)).toEqual([0, -1]);
    // The row's own controls are no Tab stops.
    for (const control of first.querySelectorAll(
      "a, button, [role=checkbox]"
    )) {
      expect((control as HTMLElement).tabIndex).toBe(-1);
    }

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    expect(rows().map((row) => row.tabIndex)).toEqual([-1, 0]);
    fireEvent.keyDown(second, { key: "k" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "j" });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: " " });
    expect(await view.findByText("1 selected")).toBeTruthy();

    fireEvent.keyDown(second, { key: "Enter" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/workflows/workflow_2")
    );
  });

  it("opens a palette with the chord that opens a workflow by name", async () => {
    stubDashboardRpc(null, [
      workflow("workflow_1", "Welcome email"),
      workflow("workflow_2", "Renewal reminder"),
    ]);
    const { view, router } = await renderWorkflowsPage();
    await view.findByText("Renewal reminder");

    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = await view.findByRole("combobox", {
      name: "Search workflows and commands",
    });
    expect(view.getByRole("option", { name: "New workflow" })).toBeTruthy();
    expect(view.getByRole("option", { name: /^Theme: Dark/ })).toBeTruthy();
    expect(
      view.getByRole("option", { name: /^Keyboard shortcuts/ })
    ).toBeTruthy();

    fireEvent.change(input, { target: { value: "renew" } });
    fireEvent.click(
      await view.findByRole("option", { name: "Renewal reminder" })
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/workflows/workflow_2")
    );
  });

  it("shows the bulk actions only once a workflow is selected", async () => {
    stubDashboardRpc(null, [workflow("workflow_1", "Welcome email")]);
    const { view } = await renderWorkflowsPage();

    await view.findByText("Welcome email");
    expect(view.queryByRole("button", { name: "Delete" })).toBeNull();

    fireEvent.click(
      view.getByRole("checkbox", { name: "Select Welcome email" })
    );
    expect(await view.findByText("1 selected")).toBeTruthy();
    expect(view.getByRole("button", { name: "Delete" })).toBeTruthy();
    // The bulk actions take the workflow panel's Refresh slot; All Runs keeps its own.
    expect(view.getAllByRole("button", { name: "Refresh" })).toHaveLength(1);
  });
});
