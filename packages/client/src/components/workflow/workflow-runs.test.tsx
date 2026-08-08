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
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { WorkflowRuns } from "#src/components/workflow/workflow-runs";
import {
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
import {
  currentWorkflowIdAtom,
  isWorkflowOwnerAtom,
} from "#src/lib/workflow-save-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import { propertiesPanelActiveTabAtom } from "#src/lib/workflow-ui-store";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";

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
};

/** The mock logs endpoint's version id for one execution: a run pins a version,
 * mocked here as a fixed function of the execution id so a test can address
 * `served.graphs` by it without threading a real version id through. */
function versionIdFor(executionId: string): string {
  return `ver_${executionId}`;
}

/**
 * Stub fetch so the run panel's oRPC procedures read from `served`. The utils
 * object rebuilds each procedure helper on every property access, so nested
 * spies cannot stick; answering by URL path is what isolate:false needs.
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

/**
 * Editor-shell mount for the overlay sync, matching production: the headless
 * component lives on the workflow route, not inside the Runs panel. Optional
 * children are the panel UI when a case needs to click a row.
 */
function EditorShell({ children }: { children?: ReactNode }) {
  return (
    <>
      <ExecutionOverlaySync />
      {children ?? null}
    </>
  );
}

function renderRuns(options?: { executionId?: string; panel?: boolean }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(isWorkflowOwnerAtom, true);
  store.set(propertiesPanelActiveTabAtom, "runs");

  const showPanel = options?.panel !== false;

  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: { executionId?: string } & SearchSchemaInput) => ({
      executionId:
        typeof search.executionId === "string" && search.executionId.length > 0
          ? search.executionId
          : undefined,
    }),
    component: () => (
      <EditorShell>{showPanel ? <WorkflowRuns /> : null}</EditorShell>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [
        options?.executionId === undefined
          ? "/workflows/wf_1"
          : `/workflows/wf_1?executionId=${options.executionId}`,
      ],
    }),
  });

  const view = render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </JotaiProvider>
  );

  return { view, queryClient, router, store };
}

function resetServed(): void {
  served.items = [];
  served.supersededCount = 0;
  served.graphs = {};
  served.logsSummaryExtras = {};
  stubRunQueries();
}

describe("WorkflowRuns", () => {
  beforeEach(resetServed);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A newest-wins workflow supersedes the open run out of the polled list, so
  // the detail view has to survive its row disappearing from underneath it.
  it("keeps the detail view open when its run leaves the list", async () => {
    served.items = [execution("exec_1", "running")];
    const { view, queryClient } = renderRuns();

    const row = await view.findByTestId("workflow-run-summary-row");
    fireEvent.click(row);

    expect(
      await view.findByRole("button", { name: "Back to runs list" })
    ).toBeTruthy();

    served.items = [];
    await act(async () => {
      await queryClient.refetchQueries();
    });

    await waitFor(() => {
      expect(view.getByText(/has left the runs list/)).toBeTruthy();
    });
    expect(
      view.getByRole("button", { name: "Back to runs list" })
    ).toBeTruthy();
  });

  it("says nothing about the list while the run is still in it", async () => {
    served.items = [execution("exec_1", "running")];
    const { view } = renderRuns();

    fireEvent.click(await view.findByTestId("workflow-run-summary-row"));

    await waitFor(() => {
      expect(
        view.getByRole("button", { name: "Back to runs list" })
      ).toBeTruthy();
    });
    expect(view.queryByText(/has left the runs list/)).toBeNull();
  });

  it("opens the run named in the search param", async () => {
    served.items = [execution("exec_deep", "completed")];
    const { view } = renderRuns({ executionId: "exec_deep" });

    expect(
      await view.findByRole("button", { name: "Back to runs list" })
    ).toBeTruthy();
    expect(view.queryByText(/has left the runs list/)).toBeNull();
  });

  it("opens a superseded run from the search param", async () => {
    served.items = [
      execution("exec_live", "completed"),
      execution("exec_old", "superseded"),
    ];
    served.supersededCount = 1;
    const { view } = renderRuns({ executionId: "exec_old" });

    expect(
      await view.findByRole("button", { name: "Back to runs list" })
    ).toBeTruthy();
  });

  it("opens a search-param run past the list from the logs summary", async () => {
    served.items = [execution("exec_other", "completed")];
    // Past the newest-50 cap the list has no row; the logs summary alone must
    // still paint Test Mode and the start source. Use "manual" so the source
    // assertion cannot be satisfied by the mock's "event" default.
    served.logsSummaryExtras = {
      exec_past_cap: {
        runMode: "test",
        startSource: "manual",
        startEventName: null,
        entityValue: "appt_99",
      },
    };
    const { view } = renderRuns({ executionId: "exec_past_cap" });

    expect(
      await view.findByRole("button", { name: "Back to runs list" })
    ).toBeTruthy();
    expect(view.getByText(/has left the runs list/)).toBeTruthy();
    expect(view.getByText("Test Mode")).toBeTruthy();
    expect(view.getByText("manual")).toBeTruthy();
  });

  it("clears the search param when going back to the list", async () => {
    served.items = [execution("exec_deep", "completed")];
    const { view, router } = renderRuns({ executionId: "exec_deep" });

    fireEvent.click(
      await view.findByRole("button", { name: "Back to runs list" })
    );

    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    expect(
      view.queryByRole("button", { name: "Back to runs list" })
    ).toBeNull();

    // #40: the panel's own Back must replace the run's history entry, not
    // push a new one on top of it — otherwise the browser Back button undoes
    // this exit and reopens the run the user just closed.
    expect(router.history.canGoBack()).toBe(false);
    await act(async () => {
      router.history.back();
    });
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
  });
});

describe("ExecutionOverlaySync", () => {
  beforeEach(resetServed);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Selecting a run, leaving it (draft / newer version on screen), then
  // reopening the same run must restore that run's pinned graph — not leave
  // the canvas on the live draft. The harness mounts the headless sync on the
  // route (editor shell) and the panel only to write the URL via clicks.
  it("re-applies the pinned graph after leaving and reopening a run", async () => {
    served.items = [
      execution("exec_new", "completed"),
      execution("exec_old", "completed"),
    ];
    served.graphs = {
      [versionIdFor("exec_old")]: pinnedGraph("v1_lifecycle"),
      [versionIdFor("exec_new")]: pinnedGraph("v2_lifecycle"),
    };
    const { view, store } = renderRuns();

    const rows = await view.findAllByTestId("workflow-run-summary-row");
    // Newest-first list: exec_new then exec_old.
    fireEvent.click(rows[1]!);

    await waitFor(() => {
      expect(
        store.get(executionOverlayGraphAtom)?.nodes.map((n) => n.id)
      ).toEqual(["v1_lifecycle"]);
    });

    fireEvent.click(
      await view.findByRole("button", { name: "Back to runs list" })
    );

    await waitFor(() => {
      expect(store.get(executionOverlayGraphAtom)).toBeNull();
      expect(view.getAllByTestId("workflow-run-summary-row")).toHaveLength(2);
    });

    fireEvent.click(view.getAllByTestId("workflow-run-summary-row")[1]!);

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
      panel: false,
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
        search: { executionId: "exec_old" },
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
      panel: false,
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
        search: { executionId: "exec_b" },
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

  // The server's node-status list is not exhaustive: it reports only nodes
  // that have an execution-log row for that run, so a node the new run has
  // not reached is simply absent from it rather than reported idle. Nothing
  // clears statusByNodeIdAtom on a straight run-to-run switch other than this
  // sync effect, so without a reset a node id shared between two runs would
  // go on showing what the first run did.
  it("resets stale node statuses when switching straight to another run", async () => {
    served.items = [
      execution("exec_new", "completed"),
      execution("exec_old", "completed"),
    ];
    served.graphs = {
      [versionIdFor("exec_old")]: pinnedGraph("shared_lifecycle"),
      [versionIdFor("exec_new")]: pinnedGraph("shared_lifecycle"),
    };
    const { store, router } = renderRuns({
      executionId: "exec_new",
      panel: false,
    });

    await waitFor(() => {
      expect(
        store.get(executionOverlayGraphAtom)?.nodes.map((n) => n.id)
      ).toEqual(["shared_lifecycle"]);
    });

    // Paint a status while exec_new is open, the way the run-status poll in
    // page.tsx would.
    store.set(setNodeStatusesAtom, [
      { nodeId: "shared_lifecycle", status: "running" },
    ]);
    expect(
      store.get(displayNodesAtom).find((node) => node.id === "shared_lifecycle")
        ?.data.status
    ).toBe("running");

    await act(async () => {
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: { executionId: "exec_old" },
      });
    });

    await waitFor(() => {
      expect(
        store.get(executionOverlayGraphAtom)?.nodes.map((n) => n.id)
      ).toEqual(["shared_lifecycle"]);
    });

    // exec_old's own status poll never ran in this test (that lives in
    // page.tsx), so a node still reading "running" here can only be the
    // previous run's stale entry surviving the switch. With the map reset,
    // displayNodesAtom's fast path (no statuses, no inactive branch) hands
    // the node back with no status field at all -- equivalent to idle, since
    // the node components treat a missing status the same as "idle".
    expect(
      store.get(displayNodesAtom).find((node) => node.id === "shared_lifecycle")
        ?.data.status ?? "idle"
    ).toBe("idle");
  });

  // A logs poll advances dataUpdatedAt; the overlay key must not, or every
  // poll would rebuild nodes as idle and wipe statuses the status poll painted.
  // Status lives off the overlay's own node data now, in statusByNodeIdAtom
  // (merged in by displayNodesAtom), so this exercises that atom rather than
  // reaching into the overlay's nodes the way the pinned graph used to carry it.
  it("does not reset node statuses when logs poll", async () => {
    served.items = [execution("exec_1", "running")];
    served.graphs = { [versionIdFor("exec_1")]: pinnedGraph("v1_lifecycle") };
    const { view, store, queryClient } = renderRuns();

    fireEvent.click(await view.findByTestId("workflow-run-summary-row"));

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
