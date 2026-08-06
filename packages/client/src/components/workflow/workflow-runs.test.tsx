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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowRuns } from "#src/components/workflow/workflow-runs";
import {
  executionOverlayGraphAtom,
  hydrateWorkflowAtom,
} from "#src/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  isWorkflowOwnerAtom,
} from "#src/lib/workflow-save-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import { propertiesPanelActiveTabAtom } from "#src/lib/workflow-ui-store";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@rova/shared/graph/types";

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
const served = vi.hoisted(() => ({
  items: [] as RawExecution[],
  supersededCount: 0,
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
}));

vi.mock("#src/lib/rpc-query", () => ({
  refreshRunHistory: () => undefined,
  orpcQuery: {
    workflow: {
      getExecutions: {
        queryOptions: ({
          input,
          select,
        }: {
          input: { workflowId: string; includeSuperseded: boolean };
          select: (payload: unknown) => unknown;
        }) => ({
          queryKey: ["executions", input.workflowId, input.includeSuperseded],
          queryFn: () => ({
            items: input.includeSuperseded
              ? served.items
              : served.items.filter((item) => item.status !== "superseded"),
            supersededCount: served.supersededCount,
            refusedStarts: [],
          }),
          select,
        }),
      },
      getExecutionLogs: {
        queryOptions: ({
          input,
          select,
        }: {
          input: { executionId: string };
          select: (payload: unknown) => unknown;
        }) => ({
          queryKey: ["logs", input.executionId],
          queryFn: () => {
            const listed = served.items.find(
              (item) => item.id === input.executionId
            );
            const extras = served.logsSummaryExtras[input.executionId] ?? {};
            return {
              execution: {
                id: input.executionId,
                workflowId: listed?.workflowId ?? "wf_1",
                status: listed?.status ?? "completed",
                startSource: listed?.startSource ?? "event",
                runMode: listed?.runMode ?? "live",
                startEventName: listed?.startEventName ?? null,
                entityValue: listed?.entityValue ?? null,
                error: null,
                startedAt: "2026-03-01T10:00:00.000Z",
                completedAt: "2026-03-01T10:00:30.000Z",
                duration: "30s",
                input: {},
                output: {},
                ...extras,
              },
              logs: [],
              waits: [],
              ...(served.graphs[input.executionId]
                ? { graph: served.graphs[input.executionId] }
                : {}),
            };
          },
          select,
        }),
      },
      getExecutionEvents: {
        queryOptions: ({
          select,
        }: {
          select: (payload: unknown) => unknown;
        }) => ({
          queryKey: ["events"],
          queryFn: () => ({ events: [] }),
          select,
        }),
      },
      cancelExecution: {
        mutationOptions: () => ({ mutationFn: () => Promise.resolve({}) }),
      },
      resumeWait: {
        mutationOptions: () => ({ mutationFn: () => Promise.resolve({}) }),
      },
    },
  },
}));

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

function renderRuns(options?: { executionId?: string }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(isWorkflowOwnerAtom, true);
  store.set(propertiesPanelActiveTabAtom, "runs");

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
    component: () => <WorkflowRuns />,
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

describe("WorkflowRuns", () => {
  beforeEach(() => {
    served.items = [];
    served.supersededCount = 0;
    served.graphs = {};
    served.logsSummaryExtras = {};
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
    // still paint Test Mode and the event start source.
    served.logsSummaryExtras = {
      exec_past_cap: {
        runMode: "test",
        startSource: "event",
        startEventName: "app/appointment.created",
        entityValue: "appt_99",
      },
    };
    const { view } = renderRuns({ executionId: "exec_past_cap" });

    expect(
      await view.findByRole("button", { name: "Back to runs list" })
    ).toBeTruthy();
    expect(view.getByText(/has left the runs list/)).toBeTruthy();
    expect(view.getByText("Test Mode")).toBeTruthy();
    expect(view.getByText("event")).toBeTruthy();
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
  });

  // Selecting a run, leaving it (draft / newer version on screen), then
  // reopening the same run must restore that run's pinned graph — not leave
  // the canvas on the live draft.
  it("re-applies the pinned graph after leaving and reopening a run", async () => {
    served.items = [
      execution("exec_new", "completed"),
      execution("exec_old", "completed"),
    ];
    served.graphs = {
      exec_old: pinnedGraph("v1_lifecycle"),
      exec_new: pinnedGraph("v2_lifecycle"),
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
      exec_old: pinnedGraph("v1_lifecycle"),
      exec_new: pinnedGraph("v2_lifecycle"),
    };
    const { store, router } = renderRuns({ executionId: "exec_new" });

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

  // Cross-workflow deep link while Runs stays mounted: the pinned graph can be
  // ready before the route loader hydrates. Painting then would be cleared by
  // hydrate while the sync key stayed `ready`, leaving the canvas on the draft.
  it("waits for hydrate before painting a deep-linked run on another workflow", async () => {
    served.items = [
      execution("exec_a", "completed", "wf_1"),
      execution("exec_b", "completed", "wf_2"),
    ];
    served.graphs = {
      exec_a: pinnedGraph("a_lifecycle"),
      exec_b: pinnedGraph("b_lifecycle"),
    };
    const { store, router } = renderRuns({ executionId: "exec_a" });

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

  // A logs poll advances dataUpdatedAt; the overlay key must not, or every
  // poll would rebuild nodes as idle and wipe statuses the status poll painted.
  it("does not reset overlay node statuses when logs poll", async () => {
    served.items = [execution("exec_1", "running")];
    served.graphs = { exec_1: pinnedGraph("v1_lifecycle") };
    const { view, store, queryClient } = renderRuns();

    fireEvent.click(await view.findByTestId("workflow-run-summary-row"));

    await waitFor(() => {
      expect(store.get(executionOverlayGraphAtom)?.nodes[0]?.id).toBe(
        "v1_lifecycle"
      );
    });

    const overlay = store.get(executionOverlayGraphAtom);
    expect(overlay).not.toBeNull();
    store.set(executionOverlayGraphAtom, {
      ...overlay!,
      nodes: overlay!.nodes.map((node) => ({
        ...node,
        data: { ...node.data, status: "success" as const },
      })),
    });

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["logs", "exec_1"] });
    });

    await waitFor(() => {
      expect(store.get(executionOverlayGraphAtom)?.nodes[0]?.data.status).toBe(
        "success"
      );
    });
  });
});
