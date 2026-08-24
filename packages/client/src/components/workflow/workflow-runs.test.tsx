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
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { ConfigurationOverlay } from "#src/components/overlays/configuration-overlay";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { WorkflowRuns } from "#src/components/workflow/workflow-runs";
import {
  canvasEditingLockedAtom,
  displayNodesAtom,
  executionOverlayGraphAtom,
  hydrateWorkflowAtom,
  selectedNodeAtom,
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
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
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
  logsByExecutionId: {},
  waitsByExecutionId: {},
};

let holdExecutions = false;
let releaseHeldExecutions: (() => void) | null = null;

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

      if (procedurePath === "workflow/getExecutions" && holdExecutions) {
        return new Promise<Response>((resolve) => {
          releaseHeldExecutions = () => {
            resolve(answerWorkflowRunRpc(served, procedurePath, {}));
          };
        });
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

function renderRuns(options?: {
  executionId?: string;
  listActions?: ReactNode;
  mobileOverlay?: boolean;
  panel?: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(isWorkflowOwnerAtom, true);
  store.set(workflowWorkspaceViewAtom, "runs");

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
      <EditorShell>
        {showPanel ? (
          options?.mobileOverlay ? (
            <ConfigurationOverlay overlayId="configuration-test" />
          ) : (
            <WorkflowRuns listActions={options?.listActions} />
          )
        ) : null}
      </EditorShell>
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
        <ExtensionCatalogProvider value={emptyExtensionCatalog}>
          <IntegrationUiProvider value={{}}>
            <OverlayProvider>
              <RouterProvider router={router} />
            </OverlayProvider>
          </IntegrationUiProvider>
        </ExtensionCatalogProvider>
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
  served.logsByExecutionId = {};
  served.waitsByExecutionId = {};
  holdExecutions = false;
  releaseHeldExecutions = null;
  stubRunQueries();
}

describe("WorkflowRuns", () => {
  beforeEach(resetServed);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses static placeholders while the initial run list loads", async () => {
    holdExecutions = true;
    const { view } = renderRuns();

    expect(await view.findByLabelText("Loading runs")).toBeTruthy();
    expect(view.container.innerHTML).not.toContain("animate-pulse");

    await act(async () => {
      releaseHeldExecutions?.();
    });
  });

  it("shows list actions when the desktop run list is empty", async () => {
    const { view } = renderRuns({
      listActions: (
        <>
          <button type="button">Refresh</button>
          <button type="button">Clear All</button>
        </>
      ),
    });

    await view.findByText("No runs yet");
    expect(view.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Clear All" })).toBeTruthy();
  });

  it("shows each run-list action once in the populated mobile sheet", async () => {
    served.items = [execution("exec_1", "completed")];
    const { view } = renderRuns({ mobileOverlay: true });

    fireEvent.click(
      await view.findByRole("button", { name: "Back to runs list" })
    );

    await view.findByTestId("workflow-run-summary-row");
    expect(view.getAllByRole("button", { name: "Refresh" })).toHaveLength(1);
    expect(view.getAllByRole("button", { name: "Clear All" })).toHaveLength(1);
  });

  it("selects the newest run when the initial list resolves", async () => {
    served.items = [execution("exec_newest", "completed")];
    const { view, router } = renderRuns();

    expect(
      await view.findByRole("button", { name: "Back to runs list" })
    ).toBeTruthy();
    expect(router.state.location.search).toEqual({
      executionId: "exec_newest",
    });
    expect(view.queryByText("Execution Inspector")).toBeNull();
  });

  it("keeps the list open after leaving the initially selected run", async () => {
    served.items = [execution("exec_newest", "completed")];
    const { view, router } = renderRuns();

    fireEvent.click(
      await view.findByRole("button", { name: "Back to runs list" })
    );

    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
      expect(view.getByText("Execution Inspector")).toBeTruthy();
    });
    expect(
      view.queryByRole("button", { name: "Back to runs list" })
    ).toBeNull();
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
    // still paint Test and the start source. Use "manual" so the source
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
    expect(view.getByText("Test")).toBeTruthy();
    expect(view.getByText("Manual")).toBeTruthy();
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

  it("restores focus to the run row after returning from its overview", async () => {
    served.items = [execution("exec_1", "completed")];
    const { view } = renderRuns({ executionId: "exec_1" });

    fireEvent.click(
      await view.findByRole("button", { name: "Back to runs list" })
    );

    await waitFor(() => {
      expect(
        view.queryByRole("button", { name: "Back to runs list" })
      ).toBeNull();
    });
    const row = view.getByTestId("workflow-run-summary-row");
    fireEvent.click(row);
    fireEvent.click(
      await view.findByRole("button", { name: "Back to runs list" })
    );

    await waitFor(() => {
      expect(view.getByTestId("workflow-run-summary-row")).toBe(
        document.activeElement
      );
    });
  });

  it("opens the node inspector from a canvas selection without leaving Runs", async () => {
    served.items = [execution("exec_1", "completed")];
    served.logsByExecutionId = {
      exec_1: [
        {
          id: "log_wait",
          nodeId: "wait_1",
          nodeName: "Wait",
          nodeType: "wait",
          status: "success",
          startedAt: "2026-03-01T10:00:00.000Z",
          completedAt: "2026-03-01T10:00:09.000Z",
          duration: "9030",
          input: { invoiceId: "inv_1" },
          output: { ok: true },
          error: null,
        },
      ],
    };
    const { view, store } = renderRuns({ executionId: "exec_1" });

    expect(
      await view.findByRole("button", { name: "Back to runs list" })
    ).toBeTruthy();

    act(() => {
      store.set(selectedNodeAtom, "wait_1");
    });

    expect(await view.findByRole("heading", { name: "Wait" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Technical details" }));
    fireEvent.click(view.getByRole("tab", { name: "Input" }));
    expect(view.getByText(/invoiceId/)).toBeTruthy();
    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");

    fireEvent.click(view.getByRole("button", { name: "Back to run overview" }));

    expect(
      await view.findByRole("button", { name: "Back to runs list" })
    ).toBeTruthy();
    expect(store.get(selectedNodeAtom)).toBeNull();
    expect(view.queryByRole("heading", { name: "Wait" })).toBeNull();
  });

  it("selects the canvas node from an executed-node row", async () => {
    served.items = [execution("exec_1", "completed")];
    served.logsByExecutionId = {
      exec_1: [
        {
          id: "log_life",
          nodeId: "lifecycle_1",
          nodeName: "Lifecycle",
          nodeType: "lifecycle",
          status: "success",
          startedAt: "2026-03-01T10:00:00.000Z",
          completedAt: "2026-03-01T10:00:00.000Z",
          duration: "0",
          input: {},
          output: {},
          error: null,
        },
      ],
    };
    const { view, store } = renderRuns({ executionId: "exec_1" });

    fireEvent.click(await view.findByRole("button", { name: /Lifecycle/ }));

    await waitFor(() => {
      expect(store.get(selectedNodeAtom)).toBe("lifecycle_1");
    });
    expect(
      await view.findByRole("heading", { name: "Lifecycle" })
    ).toBeTruthy();
  });

  it("shows stored Wait input in the inspector", async () => {
    served.items = [execution("exec_1", "waiting")];
    served.logsByExecutionId = {
      exec_1: [
        {
          id: "log_wait",
          nodeId: "wait_1",
          nodeName: "Wait",
          nodeType: "wait",
          status: "success",
          startedAt: "2026-03-01T10:00:00.000Z",
          completedAt: "2026-03-01T10:00:09.000Z",
          duration: "9030",
          input: { invoiceId: "inv_9" },
          output: {},
          error: null,
        },
      ],
    };
    const { view, store } = renderRuns({ executionId: "exec_1" });

    expect(
      await view.findByRole("button", { name: "Back to runs list" })
    ).toBeTruthy();

    act(() => {
      store.set(selectedNodeAtom, "wait_1");
    });

    fireEvent.click(view.getByRole("button", { name: "Technical details" }));
    fireEvent.click(view.getByRole("tab", { name: "Input" }));
    expect(await view.findByText(/inv_9/)).toBeTruthy();
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
    const { view, store } = renderRuns({ executionId: "exec_old" });

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
      panel: false,
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

  // Leaving Runs is the other way out of a run. Workspace navigation writes no
  // URL itself, so `executionId` stays in the
  // search. The pinned graph has to step aside anyway, or the canvas keeps
  // painting the run's graph and `canvasEditingLockedAtom` keeps refusing every
  // edit, with nothing on screen to say why.
  it("hands the canvas back to the draft when Runs is left", async () => {
    served.items = [execution("exec_1", "completed")];
    served.graphs = { [versionIdFor("exec_1")]: pinnedGraph("v1_lifecycle") };
    const { store, router } = renderRuns({
      executionId: "exec_1",
      panel: false,
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

    await act(() => {
      store.set(workflowWorkspaceViewAtom, "draft");
    });

    expect(store.get(canvasEditingLockedAtom)).toBe(false);
    expect(store.get(displayNodesAtom).map((node) => node.id)).toEqual([
      "draft_lifecycle",
    ]);
    // The run stays open in the URL, so coming back to the tab paints it again
    // without a refetch.
    expect(router.state.location.search).toEqual({ executionId: "exec_1" });

    await act(() => {
      store.set(workflowWorkspaceViewAtom, "runs");
    });

    expect(store.get(displayNodesAtom).map((node) => node.id)).toEqual([
      "v1_lifecycle",
    ]);
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
