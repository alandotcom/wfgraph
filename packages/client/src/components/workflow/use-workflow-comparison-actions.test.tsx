import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import {
  beginWorkflowComparisonRequestAtom,
  comparisonSessionAtom,
  installWorkflowComparisonAtom,
  isComparisonPendingAtom,
  settleWorkflowComparisonRequestAtom,
} from "#src/lib/workflow-comparison-store";
import {
  currentWorkflowIdAtom,
  isWorkflowOwnerAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  extractRpcProcedurePath,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import { useWorkflowComparisonActions } from "./use-workflow-comparison-actions";

const comparison: WorkflowComparisonPayload = {
  baseVersion: null,
  proposedVersion: 1,
  baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
  draftGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
  hasChanges: false,
  nodeChanges: [],
  edgeChanges: [],
};

describe("useWorkflowComparisonActions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles a rejected mutation and still settles the epoch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline")))
    );
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>{children}</JotaiProvider>
        </QueryClientProvider>
      );
    }
    const { result } = renderHook(() => useWorkflowComparisonActions(), {
      wrapper: Wrapper,
    });

    await expect(result.current.openComparison()).resolves.toBeUndefined();

    expect(store.get(isComparisonPendingAtom)).toBe(false);
  });

  it("shares a comparison failure with every action hook instance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline")))
    );
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>{children}</JotaiProvider>
        </QueryClientProvider>
      );
    }
    const owner = renderHook(() => useWorkflowComparisonActions(), {
      wrapper: Wrapper,
    });
    const observer = renderHook(() => useWorkflowComparisonActions(), {
      wrapper: Wrapper,
    });

    await act(async () => owner.result.current.openComparison());

    expect(owner.result.current.isError).toBe(true);
    expect(observer.result.current.isError).toBe(true);
  });

  it("keeps the installed comparison when a refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline")))
    );
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(isWorkflowOwnerAtom, true);
    store.set(workflowWorkspaceViewAtom, "changes");
    const epoch = store.set(beginWorkflowComparisonRequestAtom, "workflow_1");
    store.set(installWorkflowComparisonAtom, {
      workflowId: "workflow_1",
      epoch,
      payload: comparison,
    });
    store.set(settleWorkflowComparisonRequestAtom, {
      workflowId: "workflow_1",
      epoch,
    });
    const installed = store.get(comparisonSessionAtom);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>{children}</JotaiProvider>
        </QueryClientProvider>
      );
    }
    const { result } = renderHook(() => useWorkflowComparisonActions(), {
      wrapper: Wrapper,
    });

    await expect(
      result.current.openComparison({ force: true })
    ).resolves.toBeUndefined();

    expect(store.get(isComparisonPendingAtom)).toBe(false);
    expect(store.get(comparisonSessionAtom)).toBe(installed);
  });

  it("waits for the immediate draft save before starting restore", async () => {
    let resolveSave!: () => void;
    const save = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const fetch = vi.fn(async (url: RequestInfo | URL) => {
      expect(extractRpcProcedurePath(rpcUrl(url))).toBe(
        "workflow/restoreVersion"
      );
      return rpcJsonResponse(savedWorkflow("workflow_1"));
    });
    vi.stubGlobal("fetch", fetch);
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(workflowApiAtom, {
      update: vi.fn(async () => {
        await save;
        return savedWorkflow("workflow_1");
      }),
    } as never);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>{children}</JotaiProvider>
        </QueryClientProvider>
      );
    }
    const { result } = renderHook(() => useWorkflowComparisonActions(), {
      wrapper: Wrapper,
    });

    act(() =>
      result.current.restore.mutate({
        workflowId: "workflow_1",
        versionId: "version_1",
      })
    );
    await waitFor(() =>
      expect(store.get(workflowApiAtom).update).toHaveBeenCalled()
    );
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => resolveSave());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it("suppresses restore when the immediate draft save fails", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(workflowApiAtom, {
      update: vi.fn(async () => {
        throw new Error("save failed");
      }),
    } as never);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>{children}</JotaiProvider>
        </QueryClientProvider>
      );
    }
    const { result } = renderHook(() => useWorkflowComparisonActions(), {
      wrapper: Wrapper,
    });

    act(() =>
      result.current.restore.mutate({
        workflowId: "workflow_1",
        versionId: "version_1",
      })
    );
    await waitFor(() => expect(result.current.restore.isError).toBe(true));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caches a late A restore while leaving the active B graph and panel unchanged", async () => {
    let resolveRestore!: (response: Response) => void;
    const restore = new Promise<Response>((resolve) => {
      resolveRestore = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => restore)
    );
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_a");
    store.set(workflowApiAtom, {
      update: vi.fn(async () => savedWorkflow("workflow_a")),
    } as never);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>{children}</JotaiProvider>
        </QueryClientProvider>
      );
    }
    const { result } = renderHook(() => useWorkflowComparisonActions(), {
      wrapper: Wrapper,
    });

    act(() =>
      result.current.restore.mutate({
        workflowId: "workflow_a",
        versionId: "version_1",
      })
    );
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    act(() => {
      store.set(currentWorkflowIdAtom, "workflow_b");
      store.set(loadWorkflowGraphAtom, {
        nodes: [
          {
            id: "b",
            type: "action",
            position: { x: 0, y: 0 },
            data: { label: "B", type: "action" },
          },
        ],
        edges: [],
      });
      store.set(workflowWorkspaceViewAtom, "runs");
    });
    await act(async () =>
      resolveRestore(rpcJsonResponse(savedWorkflow("workflow_a")))
    );

    await waitFor(() => expect(result.current.restore.isSuccess).toBe(true));
    expect(store.get(nodesAtom).map((node) => node.id)).toEqual(["b"]);
    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
    expect(
      queryClient.getQueryData(
        orpcQuery.workflow.getById.queryKey({
          input: { workflowId: "workflow_a" },
        })
      )
    ).toMatchObject({ id: "workflow_a" });
  });
});
