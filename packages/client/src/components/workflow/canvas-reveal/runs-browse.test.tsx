import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
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
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { CanvasReveal } from "#src/components/workflow/canvas-reveal/canvas-reveal";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  answerWorkflowRunRpc,
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcErrorResponse,
  rpcJsonResponse,
  rpcUrl,
  type WorkflowRunRpcFixture,
} from "#src/lib/rpc-fetch-test-support";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
  selectedNodeAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
} from "#src/lib/workflow-save-store";
import {
  activeWorkspaceAddressAtom,
  activeWorkspaceCamerasAtom,
  recordWorkspaceCameraAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  WfGraphOperationIds,
  WfGraphOperations,
} from "@wfgraph/shared/authorization/operations";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import type { JsonObject } from "@wfgraph/shared/types/json";

type RawExecution = WorkflowRunRpcFixture["items"][number];

function execution(
  id: string,
  status: string,
  entityValue: string | null = null
): RawExecution {
  return {
    id,
    workflowId: "wf_1",
    workflowRunId: `run_${id}`,
    status,
    startedAt: "2026-03-01T10:00:00.000Z",
    completedAt: null,
    waitingAt: null,
    cancelledAt: null,
    duration: status === "completed" ? "30000" : null,
    error: null,
    entityValue,
    startEventName: "app/appointment.created",
    runMode: "live",
    startSource: "event",
  };
}

function log(input: {
  id: string;
  nodeId: string;
  nodeName: string;
  status: string;
  error?: string;
}) {
  return {
    id: input.id,
    nodeId: input.nodeId,
    nodeName: input.nodeName,
    nodeType: "action",
    status: input.status,
    startedAt: "2026-03-01T10:00:00.000Z",
    completedAt: null,
    duration: null,
    input: {},
    output: {},
    error: input.error ?? null,
  };
}

/** A pinned graph holding one step, so each run projects a graph of its own. */
function pinnedGraph(nodeId: string): SerializedWorkflowGraph {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: nodeId,
        type: "action",
        position: { x: 0, y: 0 },
        data: { label: nodeId, type: "action", config: {} },
      },
    ],
    edges: [],
  });
}

const served: WorkflowRunRpcFixture = {
  items: [],
  supersededCount: 0,
  graphs: {},
  logsSummaryExtras: {},
  logsByExecutionId: {},
  waitsByExecutionId: {},
};

/** Each RPC request the stub received, by procedure path. */
let calls: Array<{ path: string; input: JsonObject }> = [];

/**
 * An answer that replaces the served fixture for one request, such as a held
 * or failed response. Returning undefined leaves the request to the fixture.
 */
let override:
  | ((path: string, input: JsonObject) => Promise<Response> | undefined)
  | undefined;

function callCount(path: string): number {
  return calls.filter((call) => call.path === path).length;
}

beforeEach(() => {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width: 1440 });
  installAuthorizationGrantsForTests(WfGraphOperationIds);
  served.items = [];
  served.supersededCount = 0;
  served.refusedStarts = [];
  served.cancelNotDelivered = [];
  served.graphs = {};
  served.logsSummaryExtras = {};
  served.logsByExecutionId = {};
  served.waitsByExecutionId = {};
  served.exitByExecutionId = {};
  calls = [];
  override = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = extractRpcProcedurePath(rpcUrl(input));
      const requestInput = await parseRpcRequestInput(init);
      calls.push({ path, input: requestInput });
      return (
        override?.(path, requestInput) ??
        answerWorkflowRunRpc(served, path, requestInput)
      );
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthorizationGrantsForTests();
});

async function renderRunsReveal(search: WorkflowRouteSearch) {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes: [], edges: [] });
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(currentWorkflowNameAtom, "Appointment reminders");

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
      <div className="relative" data-testid="canvas-area">
        <div data-testid="workflow-canvas" />
        <ExecutionOverlaySync />
        <WorkspaceRouteSync />
        <CanvasReveal />
      </div>
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
      initialEntries: [`/workflows/wf_1${query ? `?${query}` : ""}`],
    }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const view = render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ExtensionCatalogProvider value={emptyExtensionCatalog}>
          <IntegrationUiProvider value={{}}>
            <ReactFlowProvider>
              <OverlayProvider>
                <RouterProvider router={router} />
              </OverlayProvider>
            </ReactFlowProvider>
          </IntegrationUiProvider>
        </ExtensionCatalogProvider>
      </QueryClientProvider>
    </JotaiProvider>
  );
  await view.findByTestId("canvas-area");

  const aside = () =>
    view.container.querySelector<HTMLElement>('[data-slot="canvas-reveal"]');
  const title = () =>
    aside()?.querySelector("header h2")?.textContent ?? undefined;
  const path = () =>
    aside()?.querySelector('[data-slot="reveal-path"]')?.textContent;
  const rows = () => view.queryAllByTestId("workflow-run-summary-row");
  const show = async (next: WorkflowRouteSearch) => {
    await act(async () => {
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: next,
      });
    });
  };
  const back = () =>
    fireEvent.click(view.getByRole("button", { name: "Back" }));
  const escape = () => fireEvent.keyDown(document.body, { key: "Escape" });
  const listScroller = () =>
    aside()?.querySelector<HTMLElement>('[data-slot="runs-list-scroller"]') ??
    null;
  return {
    view,
    store,
    router,
    queryClient,
    aside,
    title,
    path,
    rows,
    show,
    back,
    escape,
    listScroller,
  };
}

/** Let every pending after-paint timer run. */
async function afterPaint() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function waitingRun(id: string, token: string) {
  return [
    {
      id: `wait_${id}`,
      nodeId: "w",
      nodeName: `Wait in ${id}`,
      resumeToken: token,
      subscribedEvents: [],
      waitUntil: null,
    },
  ];
}

/** The options of the first observer reading the query under `queryKey`. */
function observerOptions(queryClient: QueryClient, queryKey: QueryKey) {
  const [query] = queryClient.getQueryCache().findAll({ queryKey });
  const [observer] = query?.observers ?? [];
  if (!observer) {
    throw new Error("no observer reads this query");
  }
  return observer.options;
}

describe("Runs Browse run list and selected run", () => {
  it("opens the newest run by replacing the entry, and names it in the header", async () => {
    served.items = [
      execution("exec_b", "completed", "appt_2"),
      execution("exec_a", "running"),
    ];
    const { view, router, aside, title, path } = await renderRunsReveal({
      view: "runs",
    });

    await waitFor(() => expect(title()).toBe("Run #2"));
    expect(router.state.location.search).toEqual({
      view: "runs",
      executionId: "exec_b",
    });
    expect(router.history.canGoBack()).toBe(false);
    expect(aside()?.getAttribute("aria-label")).toBe("Runs inspector");
    expect(path()).toBe("Appointment reminders › Runs › Run #2");
    expect(aside()?.querySelector("header")?.textContent).toContain(
      "Completed"
    );
    expect(view.getByRole("heading", { name: "app/appointment.created" }));
    expect(view.getByRole("status").textContent).toBe("Completed in 30.00s");
    expect(view.getByText("appt_2")).toBeTruthy();
    expect(view.getByText("Started")).toBeTruthy();
  });

  it("presents the run list, pushes a selected run, and returns focus to its row on Back", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "running"),
    ];
    const { view, router, title, path, rows, back } = await renderRunsReveal({
      view: "runs",
    });
    await waitFor(() => expect(title()).toBe("Run #2"));
    back();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(title()).toBe("Runs");
    expect(path()).toBe("Appointment reminders › Runs");
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();
    expect(view.getByRole("button", { name: "Refresh" })).toBeTruthy();

    fireEvent.click(rows()[1]);
    await waitFor(() => expect(title()).toBe("Run #1"));
    expect(router.state.location.search).toEqual({
      view: "runs",
      executionId: "exec_a",
    });
    expect(router.history.canGoBack()).toBe(true);

    back();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(router.state.location.search).toEqual({ view: "runs" });
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
  });

  it("projects each run's pinned graph and restores that run's selection", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    served.graphs = {
      ver_exec_a: pinnedGraph("a_step"),
      ver_exec_b: pinnedGraph("b_step"),
    };
    const { store, title, rows, back, show } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_a",
    });
    const overlayIds = () =>
      store.get(executionOverlayGraphAtom)?.nodes.map((node) => node.id);

    await waitFor(() => expect(overlayIds()).toEqual(["a_step"]));
    await act(async () => {
      store.set(selectOnlyNodeAtom, "a_step");
    });

    back();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(rows()[0]);
    await waitFor(() => expect(overlayIds()).toEqual(["b_step"]));
    expect(title()).toBe("Run #2");
    expect(store.get(selectedNodeAtom)).toBeNull();

    await show({ view: "runs", executionId: "exec_a" });
    await waitFor(() => expect(overlayIds()).toEqual(["a_step"]));
    expect(title()).toBe("Run #1");
    expect(store.get(selectedNodeAtom)).toBe("a_step");
  });
  it("leaves an open run for its row the same way on Escape and on Back, and closes from the list", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    const { view, router, aside, title, rows, show, back, escape } =
      await renderRunsReveal({ view: "runs", executionId: "exec_a" });
    await waitFor(() => expect(title()).toBe("Run #1"));

    escape();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(router.state.location.search).toEqual({ view: "runs" });
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));

    await show({ view: "runs", executionId: "exec_a" });
    await waitFor(() => expect(title()).toBe("Run #1"));
    back();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(router.state.location.search).toEqual({ view: "runs" });
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
    expect(aside()?.dataset.level).toBe("browse");

    escape();
    await waitFor(() => expect(aside()?.dataset.level).toBe("closed"));
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("puts focus on the Reveal title when the run left behind has no row", async () => {
    served.items = [
      execution("exec_live", "completed"),
      execution("exec_old", "superseded"),
    ];
    served.supersededCount = 1;
    const { aside, title, rows, back } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_old",
    });
    await waitFor(() => expect(title()).toBe("Run #1"));

    back();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        aside()?.querySelector('[data-slot="reveal-title"]')
      )
    );
    expect(title()).toBe("Runs");
  });

  it("keeps the scroll a focused row set in place of the stored list scroll", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    const { aside, title, rows, back, listScroller } = await renderRunsReveal({
      view: "runs",
    });
    await waitFor(() => expect(title()).toBe("Run #2"));
    back();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const list = listScroller();
    if (!list) {
      throw new Error("the run list did not render");
    }
    list.scrollTop = 60;
    fireEvent.scroll(list);
    fireEvent(list, new Event("scrollend"));

    fireEvent.click(rows()[1]);
    await waitFor(() => expect(title()).toBe("Run #1"));
    // A browser scrolls a row it focuses into view; happy-dom does not, so a
    // run row taking focus stands in for that scroll here.
    aside()?.addEventListener("focusin", (event) => {
      const scroller = listScroller();
      if (
        event.target instanceof HTMLElement &&
        event.target.dataset.testid === "workflow-run-summary-row" &&
        scroller
      ) {
        scroller.scrollTop = 200;
      }
    });
    back();
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
    await afterPaint();
    expect(listScroller()?.scrollTop).toBe(200);
  });
});

describe("Runs Browse selected-run content", () => {
  it("shows active waits, the journey, activity, and Cancel and Resume", async () => {
    served.items = [execution("exec_w", "waiting")];
    served.logsByExecutionId = {
      exec_w: [
        log({
          id: "log_w",
          nodeId: "w",
          nodeName: "Wait for reply",
          status: "running",
        }),
      ],
    };
    served.waitsByExecutionId = {
      exec_w: [
        {
          id: "wait_1",
          nodeId: "w",
          nodeName: "Wait for reply",
          resumeToken: "tok_1",
          subscribedEvents: ["app/reply"],
          waitUntil: null,
        },
      ],
    };
    override = (path) =>
      path === "workflow/getExecutionEvents"
        ? Promise.resolve(
            rpcJsonResponse({
              events: [
                {
                  id: "evt_1",
                  eventType: "run_started",
                  message: "Run started",
                  metadata: null,
                  createdAt: "2026-03-01T10:00:00.000Z",
                },
              ],
            })
          )
        : undefined;
    const { view, aside } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_w",
    });

    expect(
      await view.findByRole("heading", { name: "Waiting at Wait for reply" })
    ).toBeTruthy();
    expect(aside()?.querySelector("header")?.textContent).toContain("Waiting");
    expect(view.getByText("Waiting for app/reply")).toBeTruthy();
    expect(view.getByText("Node journey")).toBeTruthy();
    expect(await view.findByText("Activity · 1")).toBeTruthy();
    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Resume now" })).toBeTruthy();
  });

  it("shows the failure summary of a failed run and the exit details of an exited run", async () => {
    served.items = [
      execution("exec_x", "exited"),
      execution("exec_f", "failed"),
    ];
    served.logsByExecutionId = {
      exec_f: [
        log({
          id: "log_f",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "error",
          error: "SMTP refused the message",
        }),
      ],
    };
    served.exitByExecutionId = {
      exec_x: {
        reason: "entity_not_found",
        entityType: "appointment",
        nodeId: "send",
        checkedAt: "2026-03-01T10:00:05.000Z",
      },
    };
    const { view, show, aside } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_f",
    });

    expect(
      await view.findByRole("heading", { name: "Failed at Send reminder" })
    ).toBeTruthy();
    expect(
      view.getAllByText("SMTP refused the message").length
    ).toBeGreaterThan(0);
    expect(aside()?.querySelector("header")?.textContent).toContain("Failed");

    await show({ view: "runs", executionId: "exec_x" });
    expect(
      await view.findByRole("heading", { name: "Exit details" })
    ).toBeTruthy();
    expect(view.getByText("Entity not found")).toBeTruthy();
  });

  it("offers no Cancel, Resume, or Clear All without their permissions", async () => {
    installAuthorizationGrantsForTests(
      WfGraphOperationIds.filter(
        (id) =>
          id !== WfGraphOperations.workflowCancelExecution.id &&
          id !== WfGraphOperations.workflowResumeWait.id &&
          id !== WfGraphOperations.workflowDeleteExecutions.id
      )
    );
    served.items = [execution("exec_w", "waiting")];
    served.waitsByExecutionId = {
      exec_w: [
        {
          id: "wait_1",
          nodeId: "w",
          nodeName: "Wait for reply",
          resumeToken: "tok_1",
          subscribedEvents: [],
          waitUntil: null,
        },
      ],
    };
    const { view, rows, back } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_w",
    });

    expect(
      await view.findByRole("heading", { name: "Waiting at Wait for reply" })
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(view.queryByRole("button", { name: "Resume now" })).toBeNull();

    back();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(view.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Clear All" })).toBeNull();
  });
});

describe("Runs Browse edge cases", () => {
  it("keeps superseded runs, refused starts, and cancellation failures understandable", async () => {
    served.items = [
      execution("exec_live", "completed"),
      execution("exec_old", "superseded"),
    ];
    served.supersededCount = 1;
    served.refusedStarts = [
      {
        id: "refused_1",
        message: "Start Filter declined the event",
        createdAt: "2026-03-01T09:59:00.000Z",
      },
    ];
    served.cancelNotDelivered = [
      {
        id: "cancel_1",
        message: "Cancel Filter declined the event",
        createdAt: "2026-03-01T09:58:00.000Z",
      },
    ];
    const { view, aside, title, rows, back } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_old",
    });

    await waitFor(() => expect(title()).toBe("Run #1"));
    expect(aside()?.querySelector("header")?.textContent).toContain(
      "Superseded"
    );
    expect(view.getByRole("status").textContent).toBe(
      "Replaced by a newer start"
    );

    back();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(
      view.getByText("1 run was superseded by a newer start")
    ).toBeTruthy();
    expect(view.getByText("Start Filter declined the event")).toBeTruthy();
    expect(view.getByText("Cancel Filter declined the event")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it("explains a deep link past the list and a run that leaves the list", async () => {
    served.items = [execution("exec_live", "running")];
    const { view, queryClient, title, show } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_past",
    });

    expect(await view.findByText(/no longer in the runs list/)).toBeTruthy();
    expect(title()).toBe("Run");

    await show({ view: "runs", executionId: "exec_live" });
    await waitFor(() => expect(title()).toBe("Run #1"));
    expect(view.queryByText(/no longer in the runs list/)).toBeNull();

    served.items = [];
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await waitFor(() =>
      expect(view.getByText(/no longer in the runs list/)).toBeTruthy()
    );
    expect(view.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("shows loading, empty, and retryable failure states", async () => {
    let releaseList: (() => void) | null = null;
    override = (path, input) =>
      path === "workflow/getExecutions" && releaseList === null
        ? new Promise<Response>((resolve) => {
            releaseList = () =>
              resolve(answerWorkflowRunRpc(served, path, input));
          })
        : undefined;
    const { view } = await renderRunsReveal({ view: "runs" });

    expect(await view.findByLabelText("Loading runs")).toBeTruthy();
    await act(async () => {
      releaseList?.();
    });
    expect(await view.findByText("No runs yet")).toBeTruthy();
    expect(view.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("retries a run list that failed to load", async () => {
    let failures = 1;
    override = (path) => {
      if (path === "workflow/getExecutions" && failures > 0) {
        failures -= 1;
        return Promise.resolve(
          rpcErrorResponse({
            code: "INTERNAL_SERVER_ERROR",
            status: 500,
            message: "Database unavailable",
          })
        );
      }
      return undefined;
    };
    const { view } = await renderRunsReveal({ view: "runs" });

    expect(await view.findByText("Runs could not be loaded.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(await view.findByText("No runs yet")).toBeTruthy();
  });

  it("marks a run that could not be loaded and returns to the list", async () => {
    override = (path) =>
      path === "workflow/getExecutionLogs"
        ? Promise.resolve(
            rpcErrorResponse({
              code: "INTERNAL_SERVER_ERROR",
              status: 500,
              message: "Database unavailable",
            })
          )
        : undefined;
    const { view, router, title, back } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_gone",
    });

    expect(await view.findByText("This run could not be loaded.")).toBeTruthy();
    expect(title()).toBe("Run unavailable");
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();

    back();
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: "runs" })
    );
    expect(await view.findByText("No runs yet")).toBeTruthy();
  });

  it("never lets a late response for an earlier run replace the open run", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    served.logsByExecutionId = {
      exec_a: [
        log({
          id: "log_a",
          nodeId: "a",
          nodeName: "A step",
          status: "success",
        }),
      ],
      exec_b: [
        log({
          id: "log_b",
          nodeId: "b",
          nodeName: "B step",
          status: "success",
        }),
      ],
    };
    served.graphs = {
      ver_exec_a: pinnedGraph("a_step"),
      ver_exec_b: pinnedGraph("b_step"),
    };
    const held: Array<() => void> = [];
    override = (path, input) =>
      input.executionId === "exec_a" &&
      (path === "workflow/getExecutionLogs" ||
        path === "workflow/getExecutionEvents")
        ? new Promise<Response>((resolve) => {
            held.push(() => resolve(answerWorkflowRunRpc(served, path, input)));
          })
        : undefined;
    const { view, store, title, show } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_a",
    });
    await waitFor(() => expect(title()).toBe("Run #1"));

    await show({ view: "runs", executionId: "exec_b" });
    expect(await view.findByText("B step")).toBeTruthy();
    await act(async () => {
      for (const release of held) {
        release();
      }
    });

    expect(title()).toBe("Run #2");
    expect(view.queryByText("A step")).toBeNull();
    expect(view.getByText("B step")).toBeTruthy();
    await waitFor(() =>
      expect(
        store.get(executionOverlayGraphAtom)?.nodes.map((node) => node.id)
      ).toEqual(["b_step"])
    );
  });
});

describe("Runs Browse reads and writes", () => {
  it("polls the list, and polls logs and events while the run is in progress", async () => {
    served.items = [execution("exec_r", "running")];
    const { view, queryClient } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_r",
    });
    await view.findByRole("button", { name: "Cancel" });

    expect(
      observerOptions(
        queryClient,
        orpcQuery.workflow.getExecutions.queryKey({
          input: { workflowId: "wf_1", includeSuperseded: true },
        })
      ).refetchInterval
    ).toBe(2000);
    const eventsOptions = observerOptions(
      queryClient,
      orpcQuery.workflow.getExecutionEvents.queryKey({
        input: { executionId: "exec_r" },
      })
    );
    expect(eventsOptions.refetchInterval).toBe(2000);
  });

  it("refreshes the run history after Cancel and after Resume", async () => {
    served.items = [execution("exec_w", "waiting")];
    served.waitsByExecutionId = {
      exec_w: [
        {
          id: "wait_1",
          nodeId: "w",
          nodeName: "Wait for reply",
          resumeToken: "tok_1",
          subscribedEvents: [],
          waitUntil: null,
        },
      ],
    };
    const { view } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_w",
    });
    const reads = [
      "workflow/getExecutions",
      "workflow/getExecutionLogs",
      "workflow/getExecutionEvents",
    ];
    const counts = () => reads.map(callCount);
    /** Wait until every read has been requested again since `before`. */
    const expectRefreshedSince = async (before: number[]) => {
      await waitFor(() =>
        counts().forEach((count, index) =>
          expect(count).toBeGreaterThan(before[index])
        )
      );
    };

    const resume = await view.findByRole("button", { name: "Resume now" });
    await waitFor(() =>
      expect(counts().every((count) => count > 0)).toBe(true)
    );
    const beforeResume = counts();
    fireEvent.click(resume);
    await waitFor(() => expect(callCount("workflow/resumeWait")).toBe(1));
    await expectRefreshedSince(beforeResume);

    const beforeCancel = counts();
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(callCount("workflow/cancelExecution")).toBe(1));
    await expectRefreshedSince(beforeCancel);
  });
  it("marks only the run whose wait a pending Resume names as resuming", async () => {
    served.items = [
      execution("exec_b", "waiting"),
      execution("exec_a", "waiting"),
    ];
    served.waitsByExecutionId = {
      exec_a: waitingRun("exec_a", "tok_a"),
      exec_b: waitingRun("exec_b", "tok_b"),
    };
    let releaseResume: (() => void) | null = null;
    override = (path, input) =>
      path === "workflow/resumeWait"
        ? new Promise<Response>((resolve) => {
            releaseResume = () =>
              resolve(answerWorkflowRunRpc(served, path, input));
          })
        : undefined;
    const { view, show } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_a",
    });

    fireEvent.click(await view.findByRole("button", { name: "Resume now" }));
    await waitFor(() =>
      expect(
        view
          .getByRole("button", { name: "Resume now" })
          .hasAttribute("disabled")
      ).toBe(true)
    );

    await show({ view: "runs", executionId: "exec_b" });
    expect(
      await view.findByRole("heading", { name: "Waiting at Wait in exec_b" })
    ).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Resume now" }).hasAttribute("disabled")
    ).toBe(false);

    await show({ view: "runs", executionId: "exec_a" });
    expect(
      await view.findByRole("heading", { name: "Waiting at Wait in exec_a" })
    ).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Resume now" }).hasAttribute("disabled")
    ).toBe(true);
    await act(async () => {
      releaseResume?.();
    });
  });

  it("reads the open run for the header and the body with one logs request", async () => {
    served.items = [execution("exec_done", "completed")];
    const { title } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_done",
    });

    await waitFor(() => expect(title()).toBe("Run #1"));
    await afterPaint();
    expect(callCount("workflow/getExecutionLogs")).toBe(1);
  });
});

describe("Runs Browse restoration", () => {
  it("restores the run, its overview scroll, and its camera after a visit to Draft", async () => {
    served.items = [execution("exec_a", "completed")];
    const { view, store, aside, title, show } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_a",
    });
    await waitFor(() => expect(title()).toBe("Run #1"));
    const scroller = () =>
      aside()?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
    const overview = scroller();
    if (!overview) {
      throw new Error("the run overview did not render");
    }
    overview.scrollTop = 120;
    fireEvent.scroll(overview);
    fireEvent(overview, new Event("scrollend"));
    const camera = { centerX: 40, centerY: 80, zoom: 0.75 };
    await act(async () => {
      store.set(recordWorkspaceCameraAtom, {
        address: store.get(activeWorkspaceAddressAtom),
        formFactor: "desktop",
        camera,
      });
    });

    await show({});
    expect(view.queryByTestId("runs-browse")).toBeNull();
    await show({ view: "runs", executionId: "exec_a" });

    await waitFor(() => expect(title()).toBe("Run #1"));
    expect(aside()?.dataset.level).toBe("browse");
    await waitFor(() => expect(scroller()?.scrollTop).toBe(120));
    expect(store.get(activeWorkspaceCamerasAtom).desktop).toEqual(camera);
  });

  it("restores the run list and its scroll without opening the newest run", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    const { router, aside, title, rows, back, show } = await renderRunsReveal({
      view: "runs",
    });
    await waitFor(() => expect(title()).toBe("Run #2"));
    back();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const scroller = () =>
      aside()?.querySelector<HTMLElement>('[data-slot="runs-list-scroller"]') ??
      null;
    const list = scroller();
    if (!list) {
      throw new Error("the run list did not render");
    }
    list.scrollTop = 60;
    fireEvent.scroll(list);
    fireEvent(list, new Event("scrollend"));

    await show({});
    await show({ view: "runs" });

    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(scroller()?.scrollTop).toBe(60));
    expect(router.state.location.search).toEqual({ view: "runs" });
  });
  it("restores Show superseded and the list scroll after a visit to Draft", async () => {
    served.items = [
      execution("exec_live", "completed"),
      execution("exec_old", "superseded"),
    ];
    served.supersededCount = 1;
    const { view, title, rows, back, show, listScroller } =
      await renderRunsReveal({ view: "runs", executionId: "exec_live" });
    await waitFor(() => expect(title()).toBe("Run #2"));
    back();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(view.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    const list = listScroller();
    if (!list) {
      throw new Error("the run list did not render");
    }
    list.scrollTop = 80;
    fireEvent.scroll(list);
    fireEvent(list, new Event("scrollend"));

    await show({});
    expect(view.queryByTestId("runs-browse")).toBeNull();
    await show({ view: "runs" });

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(view.getByRole("button", { name: "Hide" })).toBeTruthy();
    await waitFor(() => expect(listScroller()?.scrollTop).toBe(80));
  });
});
