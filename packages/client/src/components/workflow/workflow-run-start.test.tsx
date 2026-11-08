/**
 * What the toolbar's Run guard and the canvas show while a run the operator
 * started is still being created, with an earlier run open in Runs.
 */

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
import { Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import {
  OverlayProvider,
  useOverlay,
} from "#src/components/overlays/overlay-provider";
import type { RunRequest } from "#src/components/overlays/run-overlay";
import { RunStatusProjection } from "#src/components/workflow/run-status-projection";
import { useWorkflowActions } from "#src/components/workflow/workflow-toolbar-handlers";
import { useWorkflowToolbarState } from "#src/components/workflow/workflow-toolbar-state";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import {
  catalog,
  deferred,
  expectedSnapshot,
  graph,
  workflowId,
  workflowStore,
} from "#src/components/workflow/workflow-toolbar-test-support";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import {
  loadWorkflowGraphAtom,
  runNodeEvidenceStatusesAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { toEditorNode } from "#src/lib/workflow-graph-types";

function RunProbe() {
  const workflowState = useWorkflowToolbarState();
  const actions = useWorkflowActions(workflowState);
  const { stack } = useOverlay();
  const top = stack.at(-1) as
    | { props: { onRun?: (request: RunRequest) => void } }
    | undefined;
  return (
    <>
      <button
        onClick={() => void actions.handleExecute("published")}
        type="button"
      >
        Run published
      </button>
      <button onClick={() => top?.props.onRun?.({ input: {} })} type="button">
        Confirm run
      </button>
      <output aria-label="run busy">{String(workflowState.isExecuting)}</output>
      <output aria-label="overlay count">{stack.length}</output>
      <output aria-label="published version">
        {workflowState.publication?.publishedVersion ?? "none"}
      </output>
    </>
  );
}

const statuses: Record<string, string> = { exec_a: "completed" };
let heldExecute = deferred<Response>();
const executeCalls: unknown[] = [];

function workflowPayload() {
  return {
    id: workflowId,
    name: "Workflow",
    graph,
    draftRevision: 1,
    isPaused: false,
    mode: "test",
    visibility: "private",
    createdAt: "2026-08-23T15:00:00.000Z",
    updatedAt: "2026-08-23T15:30:00.000Z",
    hasUnpublishedChanges: false,
    publishedVersionId: "version_7",
    publishedVersion: 7,
    publishedAt: "2026-08-23T15:00:00.000Z",
  };
}

beforeEach(() => {
  installAuthorizationGrantsForTests(WfGraphOperationIds);
  heldExecute = deferred<Response>();
  executeCalls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = extractRpcProcedurePath(rpcUrl(url));
      const input = await parseRpcRequestInput(init);
      switch (path) {
        case "workflow/getById":
          return rpcJsonResponse(workflowPayload());
        case "workflow/getAll":
        case "integration/getAll":
          return rpcJsonResponse([]);
        case "workflow/getVersionGraph":
          return rpcJsonResponse({ graph: expectedSnapshot });
        case "workflow/getExecutionStatus": {
          const executionId = String(
            (input as { executionId?: unknown }).executionId
          );
          return rpcJsonResponse({
            status: statuses[executionId] ?? "running",
            nodeStatuses: [],
            openWaitNodeIds: [],
            retryingNodeIds: [],
          });
        }
        case "workflow/getExecutionLogs":
          return new Promise<Response>(() => undefined);
        case "workflow/execute":
          executeCalls.push(input);
          return heldExecute.promise;
        default:
          throw new Error(`Unexpected RPC procedure: ${path}`);
      }
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthorizationGrantsForTests();
});

async function renderWithOpenRun(search: WorkflowRouteSearch) {
  const store = workflowStore();
  store.set(loadWorkflowGraphAtom, {
    nodes: toWorkflowGraphData(graph).nodes.map(toEditorNode),
    edges: [],
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (input: WorkflowRouteSearch & SearchSchemaInput) =>
      authorizedWorkflowSearch(input, {
        canOpenRuns: true,
        canOpenComparison: true,
      }),
    component: () => (
      <>
        <WorkspaceRouteSync />
        <RunStatusProjection />
        <RunProbe />
      </>
    ),
  });
  const query = new URLSearchParams(
    Object.entries(search).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  ).toString();
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [`/workflows/${workflowId}?${query}`],
    }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ReactFlowProvider>
          <ExtensionCatalogProvider value={catalog}>
            <OverlayProvider>
              <RouterProvider router={router} />
            </OverlayProvider>
          </ExtensionCatalogProvider>
        </ReactFlowProvider>
      </QueryClientProvider>
    </JotaiProvider>
  );
  await waitFor(() =>
    expect(
      view.getByRole("status", { name: "published version" }).textContent
    ).toBe("7")
  );
  return { view, store, router };
}

describe("starting a run with another run open", () => {
  it("holds Run busy and keeps the start painted until the new run's status is read", async () => {
    const { view, store, router } = await renderWithOpenRun({
      view: "runs",
      executionId: "exec_a",
    });
    const busy = () => view.getByRole("status", { name: "run busy" });
    const overlays = () => view.getByRole("status", { name: "overlay count" });

    fireEvent.click(view.getByRole("button", { name: "Run published" }));
    await waitFor(() => expect(overlays().textContent).toBe("1"));
    fireEvent.click(view.getByRole("button", { name: "Confirm run" }));

    await waitFor(() => expect(executeCalls).toHaveLength(1));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: "runs" })
    );
    expect(busy().textContent).toBe("true");
    expect(store.get(runNodeEvidenceStatusesAtom).get("lifecycle_1")).toBe(
      "running"
    );

    fireEvent.click(view.getByRole("button", { name: "Run published" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(overlays().textContent).toBe("1");

    statuses.exec_b = "running";
    await act(async () => {
      heldExecute.resolve(
        rpcJsonResponse({
          status: "running",
          executionId: "exec_b",
          runMode: "test",
        })
      );
      await heldExecute.promise;
    });
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        view: "runs",
        executionId: "exec_b",
      })
    );
    expect(busy().textContent).toBe("true");

    statuses.exec_b = "completed";
    await waitFor(() => expect(busy().textContent).toBe("false"), {
      timeout: 2000,
    });
  });

  it("frees Run once the server starts nothing", async () => {
    const { view } = await renderWithOpenRun({
      view: "runs",
      executionId: "exec_a",
    });
    const busy = () => view.getByRole("status", { name: "run busy" });

    fireEvent.click(view.getByRole("button", { name: "Run published" }));
    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "overlay count" }).textContent
      ).toBe("1")
    );
    fireEvent.click(view.getByRole("button", { name: "Confirm run" }));
    await waitFor(() => expect(executeCalls).toHaveLength(1));

    await act(async () => {
      heldExecute.resolve(
        rpcJsonResponse({
          status: "ignored",
          runMode: "test",
          reason: "workflow_paused",
        })
      );
      await heldExecute.promise;
    });
    await waitFor(() => expect(busy().textContent).toBe("false"));
  });
});
