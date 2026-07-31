import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
            items: served.items,
            supersededCount: 0,
            refusedStarts: [],
          }),
          select,
        }),
      },
      getExecutionLogs: {
        queryOptions: ({
          select,
        }: {
          select: (payload: unknown) => unknown;
        }) => ({
          queryKey: ["logs"],
          queryFn: () => ({ logs: [], waits: [] }),
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

function renderRuns() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf_1");

  const view = render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <WorkflowRuns />
      </QueryClientProvider>
    </JotaiProvider>
  );

  return { view, queryClient };
}

describe("WorkflowRuns", () => {
  // A newest-wins workflow supersedes the open run out of the polled list, so
  // the detail view has to survive its row disappearing from underneath it.
  it("keeps the detail view open when its run leaves the list", async () => {
    served.items = [execution("exec_1", "running")];
    const { view, queryClient } = renderRuns();

    const row = await view.findByTestId("workflow-run-summary-row");
    fireEvent.click(row);

    expect(
      view.getByRole("button", { name: "Back to runs list" })
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

    expect(view.queryByText(/has left the runs list/)).toBeNull();
  });
});
