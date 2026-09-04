import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowDraftSync } from "#src/components/workflow/workflow-draft-sync";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
  remoteDraftChangeAtom,
} from "#src/lib/workflow-graph-store";
import {
  currentWorkflowIdAtom,
  hasUnsavedChangesAtom,
  recordLoadedDraftRevisionAtom,
  workflowNotFoundAtom,
} from "#src/lib/workflow-save-store";
import {
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcErrorResponse,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { activeAgentTurnIdAtom } from "#src/lib/workflow-ui-store";

const WORKFLOW_ID = "workflow_1";

function createDraftStreamHarness() {
  const encoder = new TextEncoder();
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
          cancelled.resolve();
        },
      });
      if (!controller) {
        throw new Error("Draft stream did not start");
      }
      streams.push({ controller, cancelled: cancelled.promise });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    emit(draftRevision: number, retryMs?: number) {
      const stream = streams.at(-1);
      if (!stream) {
        throw new Error("Draft stream is not connected");
      }
      // RPCLink decodes each SSE data field through the same `json` envelope
      // used by a unary response before validating the yielded value.
      stream.controller.enqueue(
        encoder.encode(
          `id: ${draftRevision}\n${retryMs === undefined ? "" : `retry: ${retryMs}\n`}event: message\ndata: ${JSON.stringify(
            {
              json: { workflowId: WORKFLOW_ID, draftRevision },
            }
          )}\n\n`
        )
      );
    },
    fail(error: Error) {
      const stream = streams.at(-1);
      if (!stream) {
        throw new Error("Draft stream is not connected");
      }
      stream.controller.error(error);
    },
    get connectionCount() {
      return streams.length;
    },
    cancelledAt(index: number) {
      const stream = streams[index];
      if (!stream) {
        throw new Error(`Draft stream ${index} was not connected`);
      }
      return stream.cancelled;
    },
  };
}

function actionNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action" },
  };
}

function workflowPayload(draftRevision: number, nodeId: string) {
  return {
    id: WORKFLOW_ID,
    name: "Workflow",
    isPaused: false,
    mode: "live" as const,
    visibility: "private" as const,
    createdAt: "2026-09-04T09:00:00.000Z",
    updatedAt: "2026-09-04T09:00:00.000Z",
    graph: createSerializedWorkflowGraph({
      nodes: [actionNode(nodeId)],
      edges: [],
    }),
    draftRevision,
    hasUnpublishedChanges: false,
  };
}

describe("WorkflowDraftSync", () => {
  beforeEach(() => {
    installAuthorizationGrantsForTests(WfGraphOperationIds);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetAuthorizationGrantsForTests();
  });

  it("puts a newer persisted draft on a clean open canvas", async () => {
    let draftRevision = 1;
    const draftStream = createDraftStreamHarness();
    const procedureCalls: string[] = [];
    const subscriptionInputs: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        procedureCalls.push(procedurePath);
        if (procedurePath === "workflow/subscribeDraft") {
          subscriptionInputs.push(await parseRpcRequestInput(init));
          return draftStream.open();
        }
        if (procedurePath === "workflow/getById") {
          return rpcJsonResponse(workflowPayload(draftRevision, "remote"));
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    store.set(loadWorkflowGraphAtom, {
      nodes: [actionNode("local")],
      edges: [],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );

    await waitFor(() => expect(draftStream.connectionCount).toBe(1));
    expect(subscriptionInputs).toContainEqual({
      workflowId: WORKFLOW_ID,
      afterDraftRevision: 1,
    });

    draftRevision = 2;
    draftStream.emit(draftRevision);
    await waitFor(
      () =>
        expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["remote"]),
      { timeout: 2_000 }
    );
    expect(procedureCalls).not.toContain("workflow/update");
  });

  it("preserves unsaved browser work and reports the newer draft", async () => {
    const draftStream = createDraftStreamHarness();
    const procedureCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        procedureCalls.push(procedurePath);
        if (procedurePath === "workflow/subscribeDraft") {
          return draftStream.open();
        }
        if (procedurePath === "workflow/getById") {
          return rpcJsonResponse(workflowPayload(2, "remote"));
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    store.set(loadWorkflowGraphAtom, {
      nodes: [actionNode("local")],
      edges: [],
    });
    store.set(hasUnsavedChangesAtom, true);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );

    await waitFor(() => expect(draftStream.connectionCount).toBe(1));
    draftStream.emit(2);
    await waitFor(() =>
      expect(store.get(remoteDraftChangeAtom)).toEqual({
        workflowId: WORKFLOW_ID,
        draftRevision: 2,
      })
    );
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["local"]);
    expect(procedureCalls).not.toContain("workflow/getById");
  });

  it("waits for the built-in agent turn before installing an external edit", async () => {
    const draftStream = createDraftStreamHarness();
    const procedureCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        procedureCalls.push(procedurePath);
        if (procedurePath === "workflow/subscribeDraft") {
          return draftStream.open();
        }
        if (procedurePath === "workflow/getById") {
          return rpcJsonResponse(workflowPayload(2, "remote"));
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    store.set(loadWorkflowGraphAtom, {
      nodes: [actionNode("local")],
      edges: [],
    });
    store.set(activeAgentTurnIdAtom, Symbol("turn_1"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );
    await waitFor(() => expect(draftStream.connectionCount).toBe(1));
    draftStream.emit(2);
    await waitFor(() => expect(store.get(remoteDraftChangeAtom)).toBeNull());
    expect(procedureCalls).not.toContain("workflow/getById");

    act(() => store.set(activeAgentTurnIdAtom, null));

    await waitFor(() =>
      expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["remote"])
    );
  });

  it("waits for the graph read to reach the observed revision", async () => {
    const draftStream = createDraftStreamHarness();
    let graphRead = 0;
    const procedureCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        procedureCalls.push(procedurePath);
        if (procedurePath === "workflow/subscribeDraft") {
          return draftStream.open();
        }
        if (procedurePath === "workflow/getById") {
          graphRead += 1;
          return rpcJsonResponse(
            workflowPayload(graphRead === 1 ? 1 : 2, "remote")
          );
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    store.set(loadWorkflowGraphAtom, {
      nodes: [actionNode("local")],
      edges: [],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );

    await waitFor(() => expect(draftStream.connectionCount).toBe(1));
    draftStream.emit(2);
    await waitFor(() =>
      expect(
        procedureCalls.filter((path) => path === "workflow/getById")
      ).toHaveLength(1)
    );
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["local"]);

    await waitFor(
      () =>
        expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["remote"]),
      { timeout: 2_000 }
    );
    expect(graphRead).toBeGreaterThanOrEqual(2);
  });

  it("retries a failed graph read until it reaches the observed revision", async () => {
    const draftStream = createDraftStreamHarness();
    let graphRead = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/subscribeDraft") {
          return draftStream.open();
        }
        if (procedurePath === "workflow/getById") {
          graphRead += 1;
          if (graphRead === 1) {
            throw new Error("temporary graph read failure");
          }
          return rpcJsonResponse(workflowPayload(2, "remote"));
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    store.set(loadWorkflowGraphAtom, {
      nodes: [actionNode("local")],
      edges: [],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );

    await waitFor(() => expect(draftStream.connectionCount).toBe(1));
    draftStream.emit(2);
    await waitFor(
      () =>
        expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["remote"]),
      { timeout: 2_000 }
    );
    expect(graphRead).toBeGreaterThanOrEqual(2);
  });

  it("installs the latest revision when it arrives during an older snapshot read", async () => {
    const draftStream = createDraftStreamHarness();
    const revisionTwoRead = Promise.withResolvers<Response>();
    let graphRead = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/subscribeDraft") {
          return draftStream.open();
        }
        if (procedurePath === "workflow/getById") {
          graphRead += 1;
          return graphRead === 1
            ? revisionTwoRead.promise
            : rpcJsonResponse(workflowPayload(3, "revision_3"));
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    store.set(loadWorkflowGraphAtom, {
      nodes: [actionNode("local")],
      edges: [],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );
    await waitFor(() => expect(draftStream.connectionCount).toBe(1));
    draftStream.emit(2);
    await waitFor(() => expect(graphRead).toBe(1));
    draftStream.emit(3);
    revisionTwoRead.resolve(rpcJsonResponse(workflowPayload(2, "revision_2")));

    await waitFor(
      () =>
        expect(store.get(nodesAtom).map((node) => node.id)).toEqual([
          "revision_3",
        ]),
      { timeout: 2_000 }
    );
    expect(graphRead).toBe(2);
  });

  it("stops snapshot retries when the open workflow was deleted", async () => {
    const draftStream = createDraftStreamHarness();
    let graphRead = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/subscribeDraft") {
          return draftStream.open();
        }
        if (procedurePath === "workflow/getById") {
          graphRead += 1;
          return rpcErrorResponse({
            code: "NOT_FOUND",
            status: 404,
            message: "Workflow not found",
          });
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );
    await waitFor(() => expect(draftStream.connectionCount).toBe(1));
    draftStream.emit(2);

    await waitFor(() => expect(store.get(workflowNotFoundAtom)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(graphRead).toBe(1);
  });

  it("ignores a not-found response from the workflow left during the read", async () => {
    const draftStream = createDraftStreamHarness();
    const staleRead = Promise.withResolvers<Response>();
    let graphRead = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/subscribeDraft") {
          return draftStream.open();
        }
        if (procedurePath === "workflow/getById") {
          graphRead += 1;
          return staleRead.promise;
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const view = render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );
    await waitFor(() => expect(draftStream.connectionCount).toBe(1));
    draftStream.emit(2);
    await waitFor(() => expect(graphRead).toBe(1));

    act(() => {
      store.set(currentWorkflowIdAtom, "workflow_2");
      store.set(recordLoadedDraftRevisionAtom, {
        workflowId: "workflow_2",
        draftRevision: 1,
      });
      view.rerender(
        <JotaiProvider store={store}>
          <QueryClientProvider client={queryClient}>
            <WorkflowDraftSync workflowId="workflow_2" />
          </QueryClientProvider>
        </JotaiProvider>
      );
    });
    await waitFor(() => expect(draftStream.connectionCount).toBe(2));

    staleRead.resolve(
      rpcErrorResponse({
        code: "NOT_FOUND",
        status: 404,
        message: "Workflow not found",
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.get(workflowNotFoundAtom)).toBe(false);
  });

  it("aborts the snapshot request when the editor navigates away", async () => {
    const draftStream = createDraftStreamHarness();
    const snapshotStarted = Promise.withResolvers<AbortSignal>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/subscribeDraft") {
          return draftStream.open();
        }
        if (procedurePath === "workflow/getById") {
          const signal = init?.signal;
          if (!signal) {
            throw new Error("Snapshot request has no abort signal");
          }
          snapshotStarted.resolve(signal);
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );
    await waitFor(() => expect(draftStream.connectionCount).toBe(1));
    await act(async () => {
      draftStream.emit(2);
      await Promise.resolve();
      await Promise.resolve();
    });
    const snapshotSignal = await snapshotStarted.promise;

    await act(async () => {
      store.set(currentWorkflowIdAtom, "workflow_2");
      store.set(recordLoadedDraftRevisionAtom, {
        workflowId: "workflow_2",
        draftRevision: 1,
      });
      view.rerender(
        <JotaiProvider store={store}>
          <QueryClientProvider client={queryClient}>
            <WorkflowDraftSync workflowId="workflow_2" />
          </QueryClientProvider>
        </JotaiProvider>
      );
      await Promise.resolve();
    });

    expect(snapshotSignal.aborted).toBe(true);
  });

  it("marks the open workflow missing when the subscription cannot find it", async () => {
    let subscriptionRead = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/subscribeDraft") {
          subscriptionRead += 1;
          return rpcErrorResponse({
            code: "NOT_FOUND",
            status: 404,
            message: "Workflow not found",
          });
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );

    await waitFor(() => expect(store.get(workflowNotFoundAtom)).toBe(true));
    expect(subscriptionRead).toBe(1);
  });

  it.each([
    { code: "UNAUTHORIZED", status: 401 },
    { code: "FORBIDDEN", status: 403 },
  ])("does not retry a $status draft subscription failure", async (failure) => {
    vi.useFakeTimers();
    const subscriptionStarted = Promise.withResolvers<void>();
    let subscriptionRead = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/subscribeDraft") {
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

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );
    await subscriptionStarted.promise;
    await act(() => Promise.resolve());

    act(() => vi.advanceTimersByTime(2_100));
    await act(() => Promise.resolve());

    expect(subscriptionRead).toBe(1);
    expect(store.get(workflowNotFoundAtom)).toBe(false);
  });

  it("marks a workflow missing when deletion ends its active subscription", async () => {
    const draftStream = createDraftStreamHarness();
    let subscriptionRead = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/subscribeDraft") {
          subscriptionRead += 1;
          return subscriptionRead === 1
            ? draftStream.open()
            : rpcErrorResponse({
                code: "NOT_FOUND",
                status: 404,
                message: "Workflow not found",
              });
        }
        if (procedurePath === "workflow/getById") {
          return rpcJsonResponse(workflowPayload(2, "remote"));
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );
    await waitFor(() => expect(draftStream.connectionCount).toBe(1));
    draftStream.emit(2, 1);
    await waitFor(() =>
      expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["remote"])
    );
    draftStream.fail(new Error("workflow deleted"));

    await waitFor(() => expect(store.get(workflowNotFoundAtom)).toBe(true));
    expect(subscriptionRead).toBe(2);
  });

  it("closes the draft subscription when the editor unmounts", async () => {
    const draftStream = createDraftStreamHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/subscribeDraft") {
          return draftStream.open();
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const view = render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );
    await waitFor(() => expect(draftStream.connectionCount).toBe(1));

    view.unmount();

    await expect(draftStream.cancelledAt(0)).resolves.toBeUndefined();
  });

  it("reconnects with the last received draft revision", async () => {
    const draftStream = createDraftStreamHarness();
    const lastEventIds: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const procedurePath = extractRpcProcedurePath(rpcUrl(input));
        if (procedurePath === "workflow/subscribeDraft") {
          lastEventIds.push(new Headers(init?.headers).get("last-event-id"));
          return draftStream.open();
        }
        throw new Error(`Unexpected RPC procedure: ${procedurePath}`);
      })
    );

    const store = createStore();
    store.set(currentWorkflowIdAtom, WORKFLOW_ID);
    store.set(recordLoadedDraftRevisionAtom, {
      workflowId: WORKFLOW_ID,
      draftRevision: 1,
    });
    store.set(hasUnsavedChangesAtom, true);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <WorkflowDraftSync workflowId={WORKFLOW_ID} />
        </QueryClientProvider>
      </JotaiProvider>
    );
    await waitFor(() => expect(draftStream.connectionCount).toBe(1));
    draftStream.emit(2, 1);
    await waitFor(() =>
      expect(store.get(remoteDraftChangeAtom)?.draftRevision).toBe(2)
    );

    draftStream.fail(new Error("connection lost"));

    await waitFor(() => expect(draftStream.connectionCount).toBe(2));
    expect(lastEventIds).toEqual([null, "2"]);
    draftStream.emit(3);
    await waitFor(() =>
      expect(store.get(remoteDraftChangeAtom)?.draftRevision).toBe(3)
    );
  });
});
