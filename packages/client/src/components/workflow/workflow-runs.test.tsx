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
import { describe, expect, it, vi } from "vitest";
import { WorkflowRuns } from "#src/components/workflow/workflow-runs";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";

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
          queryFn: () => ({
            execution: {
              id: input.executionId,
              workflowId: "wf_1",
              status: "completed",
              error: null,
              startedAt: "2026-03-01T10:00:00.000Z",
              completedAt: "2026-03-01T10:00:30.000Z",
              duration: "30s",
              input: {},
              output: {},
            },
            logs: [],
            waits: [],
          }),
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

function execution(id: string, status: string): RawExecution {
  return {
    id,
    workflowId: "wf_1",
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

function renderRuns(options?: { executionId?: string }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");

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

  return { view, queryClient, router };
}

describe("WorkflowRuns", () => {
  // A newest-wins workflow supersedes the open run out of the polled list, so
  // the detail view has to survive its row disappearing from underneath it.
  it("keeps the detail view open when its run leaves the list", async () => {
    served.items = [execution("exec_1", "running")];
    served.supersededCount = 0;
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
    served.supersededCount = 0;
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
    served.supersededCount = 0;
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
    served.supersededCount = 0;
    const { view } = renderRuns({ executionId: "exec_past_cap" });

    expect(
      await view.findByRole("button", { name: "Back to runs list" })
    ).toBeTruthy();
    expect(view.getByText(/has left the runs list/)).toBeTruthy();
  });

  it("clears the search param when going back to the list", async () => {
    served.items = [execution("exec_deep", "completed")];
    served.supersededCount = 0;
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
});
