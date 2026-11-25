import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
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

  function summary(id: string, name: string, publishedVersionId?: string) {
    return omitUndefined({
      id,
      name,
      isPaused: false,
      mode: "live",
      visibility: "private",
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:00:00.000Z",
      publishedVersionId,
    });
  }

  it("says a workflow that was never published is not active", async () => {
    stubDashboardRpc(null, [
      summary("workflow_1", "Draft only"),
      summary("workflow_2", "Running", "version_1"),
    ]);
    const { view } = await renderWorkflowsPage();

    const draftRow = (await view.findByText("Draft only")).closest("tr");
    const runningRow = view.getByText("Running").closest("tr");

    expect(draftRow?.textContent).toContain("Never published");
    expect(draftRow?.textContent).not.toContain("Active");
    expect(runningRow?.textContent).toContain("Active");
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
