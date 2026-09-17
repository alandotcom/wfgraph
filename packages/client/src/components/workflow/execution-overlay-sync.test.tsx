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
import { act, render, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import {
  canvasEditingLockedAtom,
  displayNodesAtom,
  executionOverlayGraphAtom,
  hydrateWorkflowAtom,
  setNodeStatusesAtom,
} from "#src/lib/workflow-graph-store";
import {
  answerWorkflowRunRpc,
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcUrl,
  type WorkflowRunRpcFixture,
} from "#src/lib/rpc-fetch-test-support";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import { WorkspaceRouteSync } from "./workspace-route-sync";

type RawExecution = {
  id: string;
  workflowId: string;
  workflowRunId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  waitingAt: string | null;
  cancelledAt: string | null;
  duration: string | null;
  error: string | null;
  entityValue: string | null;
  startEventName: string | null;
  runMode: string;
  startSource: string;
};

/** What the runs endpoint is answering with, rewritten between polls. */
const served: WorkflowRunRpcFixture = {
  items: [] as RawExecution[],
  supersededCount: 0,
  refusedStarts: [],
  cancelNotDelivered: [],
  /** Keyed by workflowVersionId, the key `getVersionGraph` reads by. */
  graphs: {} as Record<string, SerializedWorkflowGraph>,
  /** Start identity the logs summary carries for ids not in the list. */
  logsSummaryExtras: {} as Record<
    string,
    {
      runMode?: string;
      startSource?: string | null;
      startEventName?: string | null;
      entityValue?: string | null;
    }
  >,
  logsByExecutionId: {},
  waitsByExecutionId: {},
};

/** The mock logs endpoint's version id for one execution: a run pins a version,
 * mocked here as a fixed function of the execution id so a test can address
 * `served.graphs` by it without threading a real version id through. */
function versionIdFor(executionId: string): string {
  return `ver_${executionId}`;
}

/**
 * Stub fetch so the run reads answer from `served`. The utils object rebuilds
 * each procedure helper on every property access, so nested spies cannot
 * stick; answering by URL path is what isolate:false needs.
 */
function stubRunQueries(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = rpcUrl(input);
      const procedurePath = extractRpcProcedurePath(url);
      if (!procedurePath.startsWith("workflow/")) {
        throw new Error(`unexpected fetch in workflow-runs test: ${url}`);
      }
      const requestInput = await parseRpcRequestInput(init);
      return answerWorkflowRunRpc(served, procedurePath, requestInput);
    })
  );
}

function execution(
  id: string,
  status: string,
  workflowId = "wf_1"
): RawExecution {
  return {
    id,
    workflowId,
    workflowRunId: `run_${id}`,
    status,
    startedAt: "2026-03-01T10:00:00.000Z",
    completedAt: null,
    waitingAt: null,
    cancelledAt: null,
    duration: null,
    error: null,
    entityValue: null,
    startEventName: "app/appointment.created",
    runMode: "live",
    startSource: "event",
  };
}

function pinnedGraph(nodeId: string): SerializedWorkflowGraph {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: nodeId,
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: nodeId, type: "lifecycle" },
      },
    ],
    edges: [],
  });
}

/** An editor node for the draft a run overlay is painted over. */
function draftNode(id: string): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: id, type: "lifecycle" },
  };
}

/**
 * Editor-shell mount for the overlay sync, matching production: the headless
 * components live on the workflow route, and the route search names the run.
 */
function renderRuns(options: { executionId: string }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");

  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: WorkflowRouteSearch & SearchSchemaInput) =>
      authorizedWorkflowSearch(search, {
        canOpenRuns: true,
        canOpenComparison: true,
      }),
    component: () => (
      <>
        <ExecutionOverlaySync />
        <WorkspaceRouteSync />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [
        `/workflows/wf_1?view=runs&executionId=${options.executionId}`,
      ],
    }),
  });

  render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </JotaiProvider>
  );

  const show = async (search: WorkflowRouteSearch, workflowId = "wf_1") => {
    await act(async () => {
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId },
        search,
      });
    });
  };

  return { queryClient, router, store, show };
}

function resetServed(): void {
  installAuthorizationGrantsForTests(WfGraphOperationIds);
  served.items = [];
  served.supersededCount = 0;
  served.refusedStarts = [];
  served.cancelNotDelivered = [];
  served.graphs = {};
  served.logsSummaryExtras = {};
  served.logsByExecutionId = {};
  served.waitsByExecutionId = {};
  stubRunQueries();
}

describe("ExecutionOverlaySync", () => {
  beforeEach(resetServed);

  afterEach(() => {
    resetAuthorizationGrantsForTests();
    vi.unstubAllGlobals();
  });

  // Selecting a run, leaving it (draft / newer version on screen), then
  // reopening the same run must restore that run's pinned graph — not leave
  // the canvas on the live draft. The harness mounts the headless sync on the
  // route (editor shell), and each step navigates the route as Runs does.
  it("re-applies the pinned graph after leaving and reopening a run", async () => {
    served.items = [
      execution("exec_new", "completed"),
      execution("exec_old", "completed"),
    ];
    served.graphs = {
      [versionIdFor("exec_old")]: pinnedGraph("v1_lifecycle"),
      [versionIdFor("exec_new")]: pinnedGraph("v2_lifecycle"),
    };
    const { store, show } = renderRuns({ executionId: "exec_old" });

    await waitFor(() => {
      expect(
        store.get(executionOverlayGraphAtom)?.nodes.map((n) => n.id)
      ).toEqual(["v1_lifecycle"]);
    });

    await show({ view: "runs" });

    await waitFor(() => {
      expect(store.get(executionOverlayGraphAtom)).toBeNull();
    });

    await show({ view: "runs", executionId: "exec_old" });

    await waitFor(() => {
      expect(
        store.get(executionOverlayGraphAtom)?.nodes.map((n) => n.id)
      ).toEqual(["v1_lifecycle"]);
    });
  });

  it("switches the overlay when selecting another run while one is open", async () => {
    served.items = [
      execution("exec_new", "completed"),
      execution("exec_old", "completed"),
    ];
    served.graphs = {
      [versionIdFor("exec_old")]: pinnedGraph("v1_lifecycle"),
      [versionIdFor("exec_new")]: pinnedGraph("v2_lifecycle"),
    };
    const { store, router } = renderRuns({
      executionId: "exec_new",
    });

    await waitFor(() => {
      expect(
        store.get(executionOverlayGraphAtom)?.nodes.map((n) => n.id)
      ).toEqual(["v2_lifecycle"]);
    });

    await act(async () => {
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: { view: "runs", executionId: "exec_old" },
      });
    });

    await waitFor(() => {
      expect(
        store.get(executionOverlayGraphAtom)?.nodes.map((n) => n.id)
      ).toEqual(["v1_lifecycle"]);
    });
  });

  // Cross-workflow deep link while the shell stays mounted: the pinned graph
  // can be ready before the route loader hydrates. Painting then would be
  // cleared by hydrate while the sync key stayed `ready`, leaving the canvas
  // on the draft.
  it("waits for hydrate before painting a deep-linked run on another workflow", async () => {
    served.items = [
      execution("exec_a", "completed", "wf_1"),
      execution("exec_b", "completed", "wf_2"),
    ];
    served.graphs = {
      [versionIdFor("exec_a")]: pinnedGraph("a_lifecycle"),
      [versionIdFor("exec_b")]: pinnedGraph("b_lifecycle"),
    };
    const { store, router } = renderRuns({
      executionId: "exec_a",
    });

    await waitFor(() => {
      expect(
        store.get(executionOverlayGraphAtom)?.nodes.map((n) => n.id)
      ).toEqual(["a_lifecycle"]);
    });

    await act(async () => {
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_2" },
        search: { view: "runs", executionId: "exec_b" },
      });
    });

    await waitFor(() => {
      expect(store.get(executionOverlayGraphAtom)).toBeNull();
      expect(store.get(currentWorkflowIdAtom)).toBe("wf_1");
    });

    await act(() => {
      store.set(hydrateWorkflowAtom, savedWorkflow("wf_2"));
    });

    await waitFor(() => {
      expect(store.get(currentWorkflowIdAtom)).toBe("wf_2");
      expect(
        store.get(executionOverlayGraphAtom)?.nodes.map((n) => n.id)
      ).toEqual(["b_lifecycle"]);
    });
  });

  // Coming back to a waiting run (dashboard round-trip, or the loader's
  // stale-while-revalidate of the still-open editor) hydrates the same
  // workflow again. Run overlay, selection and statuses belong to that run,
  // so hydrate must leave them; wiping them is how a run in progress lost
  // its running animation after navigating back to it.
  it("keeps the pinned graph after a same-workflow hydrate", async () => {
    served.items = [execution("exec_1", "waiting")];
    served.graphs = { [versionIdFor("exec_1")]: pinnedGraph("v1_lifecycle") };
    const { store } = renderRuns({
      executionId: "exec_1",
    });

    await waitFor(() => {
      expect(
        store.get(executionOverlayGraphAtom)?.nodes.map((n) => n.id)
      ).toEqual(["v1_lifecycle"]);
    });

    store.set(setNodeStatusesAtom, [
      { nodeId: "v1_lifecycle", status: "running" },
    ]);

    await act(() => {
      store.set(
        hydrateWorkflowAtom,
        savedWorkflow("wf_1", {
          nodes: [draftNode("draft_lifecycle")],
          edges: [],
        })
      );
    });

    expect(
      store.get(executionOverlayGraphAtom)?.nodes.map((n) => n.id)
    ).toEqual(["v1_lifecycle"]);
    expect(
      store.get(displayNodesAtom).find((node) => node.id === "v1_lifecycle")
        ?.data.status
    ).toBe("running");
  });

  // Leaving Runs is the other way out of a run. The pinned graph has to step
  // aside, or the canvas keeps painting the run's graph and
  // `canvasEditingLockedAtom` keeps refusing every edit, with nothing on screen
  // to say why.
  it("hands the canvas back to the draft when Runs is left", async () => {
    served.items = [execution("exec_1", "completed")];
    served.graphs = { [versionIdFor("exec_1")]: pinnedGraph("v1_lifecycle") };
    const { store, router } = renderRuns({
      executionId: "exec_1",
    });
    // A draft carrying a node of its own, so the canvas handing the run back is
    // visible as that node returning. Hydrating an empty workflow would satisfy
    // the assertion below with the run graph merely gone.
    //
    // Same-workflow hydrate leaves the overlay in place and writes the draft
    // underneath it. The draft has to be installed before we leave the tab, or
    // the assertion would see an empty canvas rather than this node returning.
    store.set(
      hydrateWorkflowAtom,
      savedWorkflow("wf_1", {
        nodes: [draftNode("draft_lifecycle")],
        edges: [],
      })
    );

    await waitFor(() => {
      expect(store.get(canvasEditingLockedAtom)).toBe(true);
    });

    await act(async () => {
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: {},
      });
    });

    expect(store.get(canvasEditingLockedAtom)).toBe(false);
    expect(store.get(displayNodesAtom).map((node) => node.id)).toEqual([
      "draft_lifecycle",
    ]);

    // Returning to the run paints it again without a refetch.
    await act(async () => {
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: { view: "runs", executionId: "exec_1" },
      });
    });

    await waitFor(() =>
      expect(store.get(displayNodesAtom).map((node) => node.id)).toEqual([
        "v1_lifecycle",
      ])
    );
  });

  // A logs poll advances dataUpdatedAt; the overlay key must not, or every
  // poll would rebuild nodes as idle and wipe statuses the status poll painted.
  // Status lives off the overlay's own node data now, in statusByNodeIdAtom
  // (merged in by displayNodesAtom), so this exercises that atom rather than
  // reaching into the overlay's nodes the way the pinned graph used to carry it.
  it("does not reset node statuses when logs poll", async () => {
    served.items = [execution("exec_1", "running")];
    served.graphs = { [versionIdFor("exec_1")]: pinnedGraph("v1_lifecycle") };
    const { store, queryClient } = renderRuns({ executionId: "exec_1" });

    await waitFor(() => {
      expect(store.get(executionOverlayGraphAtom)?.nodes[0]?.id).toBe(
        "v1_lifecycle"
      );
    });

    store.set(setNodeStatusesAtom, [
      { nodeId: "v1_lifecycle", status: "success" },
    ]);

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["logs", "exec_1"] });
    });

    await waitFor(() => {
      expect(
        store.get(displayNodesAtom).find((node) => node.id === "v1_lifecycle")
          ?.data.status
      ).toBe("success");
    });
  });
});
