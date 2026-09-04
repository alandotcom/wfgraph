import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowListSync } from "#src/components/workflow/workflow-list-sync";
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
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";

const initialList = [
  {
    id: "wf_alpha",
    name: "Alpha",
    isPaused: false,
    mode: "live" as const,
    visibility: "private" as const,
    createdAt: "2026-09-04T09:00:00.000Z",
    updatedAt: "2026-09-04T09:00:00.000Z",
  },
];

const updatedList = [
  {
    ...initialList[0],
    name: "Renamed",
    updatedAt: "2026-09-04T10:00:00.000Z",
  },
];

const workflowPayload = {
  ...initialList[0],
  graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
  draftRevision: 1,
  hasUnpublishedChanges: false,
};

const runsPayload = {
  items: [],
  supersededCount: 0,
  refusedStarts: [],
  cancelNotDelivered: [],
};

function createListStreamHarness() {
  const encoder = new TextEncoder();
  let canceledCount = 0;
  const streams: Array<{
    controller: ReadableStreamDefaultController<Uint8Array>;
    cancelled: Promise<void>;
  }> = [];

  return {
    open() {
      const cancelled = Promise.withResolvers<void>();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(nextController) {
          controller = nextController;
        },
        cancel() {
          canceledCount += 1;
          cancelled.resolve();
        },
      });
      if (!controller) {
        throw new Error("Workflow list stream did not start");
      }
      streams.push({ controller, cancelled: cancelled.promise });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    emit(value: typeof initialList) {
      const stream = streams.at(-1);
      if (!stream) {
        throw new Error("Workflow list stream is not connected");
      }
      stream.controller.enqueue(
        encoder.encode(
          `event: message\ndata: ${JSON.stringify({ json: value })}\n\n`
        )
      );
    },
    get connectionCount() {
      return streams.length;
    },
    get canceledCount() {
      return canceledCount;
    },
    cancelledAt(index: number) {
      const stream = streams[index];
      if (!stream) {
        throw new Error(`Workflow list stream ${index} was not connected`);
      }
      return stream.cancelled;
    },
  };
}

describe("WorkflowListSync", () => {
  beforeEach(() => {
    installAuthorizationGrantsForTests(WfGraphOperationIds);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetAuthorizationGrantsForTests();
  });

  it("subscribes after the initial list loads and replaces only the list cache", async () => {
    const initialResponse = Promise.withResolvers<Response>();
    const listStream = createListStreamHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/getAll") {
          return initialResponse.promise;
        }
        if (procedurePath === "workflow/subscribeList") {
          return listStream.open();
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const workflowKey = orpcQuery.workflow.getById.queryKey({
      input: { workflowId: "wf_alpha" },
    });
    const runsKey = orpcQuery.workflow.getExecutions.queryKey({
      input: { workflowId: "wf_alpha" },
    });
    queryClient.setQueryData(workflowKey, workflowPayload);
    queryClient.setQueryData(runsKey, runsPayload);

    render(
      <QueryClientProvider client={queryClient}>
        <WorkflowListSync />
      </QueryClientProvider>
    );

    await waitFor(() => expect(listStream.connectionCount).toBe(0));
    initialResponse.resolve(rpcJsonResponse(initialList));
    await waitFor(() => expect(listStream.connectionCount).toBe(1));

    listStream.emit(updatedList);

    await waitFor(() =>
      expect(
        queryClient.getQueryData(
          orpcQuery.workflow.getAll.queryKey({ input: {} })
        )
      ).toEqual(updatedList)
    );
    expect(queryClient.getQueryData(workflowKey)).toEqual(workflowPayload);
    expect(queryClient.getQueryData(runsKey)).toEqual(runsPayload);
  });

  it("uses the stream after the initial list request fails", async () => {
    const listStream = createListStreamHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/getAll") {
          return rpcErrorResponse({
            code: "INTERNAL_SERVER_ERROR",
            status: 500,
            message: "List unavailable",
          });
        }
        if (procedurePath === "workflow/subscribeList") {
          return listStream.open();
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <WorkflowListSync />
      </QueryClientProvider>
    );

    await waitFor(() => expect(listStream.connectionCount).toBe(1));
    listStream.emit(initialList);
    await waitFor(() =>
      expect(
        queryClient.getQueryData(
          orpcQuery.workflow.getAll.queryKey({ input: {} })
        )
      ).toEqual(initialList)
    );
  });

  it("keeps the stream connected during a list refetch", async () => {
    const refetchResponse = Promise.withResolvers<Response>();
    const listStream = createListStreamHarness();
    let listRead = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/getAll") {
          listRead += 1;
          return listRead === 1
            ? rpcJsonResponse(initialList)
            : refetchResponse.promise;
        }
        if (procedurePath === "workflow/subscribeList") {
          return listStream.open();
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <WorkflowListSync />
      </QueryClientProvider>
    );
    await waitFor(() => expect(listStream.connectionCount).toBe(1));

    void queryClient.invalidateQueries({
      queryKey: orpcQuery.workflow.getAll.key(),
    });
    await waitFor(() => expect(listRead).toBe(2));

    expect(listStream.connectionCount).toBe(1);
    expect(listStream.canceledCount).toBe(0);
    refetchResponse.resolve(rpcJsonResponse(initialList));
  });

  it("closes the stream while hidden and reconnects when visible", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState
    );
    const listStream = createListStreamHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/getAll") {
          return rpcJsonResponse(initialList);
        }
        if (procedurePath === "workflow/subscribeList") {
          return listStream.open();
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <WorkflowListSync />
      </QueryClientProvider>
    );
    await waitFor(() => expect(listStream.connectionCount).toBe(1));

    act(() => {
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await listStream.cancelledAt(0);

    act(() => {
      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(listStream.connectionCount).toBe(2));
  });

  it.each([
    { code: "UNAUTHORIZED", status: 401 },
    { code: "FORBIDDEN", status: 403 },
  ])("does not retry a $status list subscription failure", async (failure) => {
    const subscriptionStarted = Promise.withResolvers<void>();
    let subscriptionRead = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/getAll") {
          return rpcJsonResponse(initialList);
        }
        if (procedurePath === "workflow/subscribeList") {
          subscriptionRead += 1;
          subscriptionStarted.resolve();
          return rpcErrorResponse({
            ...failure,
            message: "Workflow access denied",
          });
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <WorkflowListSync />
      </QueryClientProvider>
    );
    await act(async () => {
      await subscriptionStarted.promise;
      await Promise.resolve();
    });

    await act(() => new Promise((resolve) => setTimeout(resolve, 2_100)));

    expect(subscriptionRead).toBe(1);
  });
});
