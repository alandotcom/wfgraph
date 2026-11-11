import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  extractRpcProcedurePath,
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
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return { view, queryClient };
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
