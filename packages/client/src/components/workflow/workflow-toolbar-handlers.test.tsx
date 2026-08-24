import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import {
  createStore,
  Provider as JotaiProvider,
  useAtomValue,
  useSetAtom,
} from "jotai";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  useWorkflowActions,
  type WorkflowToolbarState,
} from "#src/components/workflow/workflow-toolbar-handlers";
import {
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import { orpcQuery } from "#src/lib/rpc-query";
import { toSerializedGraph } from "#src/lib/rpc-client";
import { canvasEditingLockedAtom } from "#src/lib/workflow-graph-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { toEditorNode } from "#src/lib/workflow-graph-types";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const workflowId = "workflow_1";
const graph = createSerializedWorkflowGraph({
  nodes: [
    {
      id: "lifecycle_1",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: { label: "Lifecycle", type: "lifecycle" },
    },
  ],
  edges: [],
});
const nodes = toWorkflowGraphData(graph).nodes.map(toEditorNode);
const expectedSnapshot = toSerializedGraph({ nodes, edges: [] });
const catalog: ExtensionCatalog = { actions: [], events: [], integrations: [] };

function workflowStore(id = workflowId) {
  const store = createStore();
  store.set(currentWorkflowIdAtom, id);
  return store;
}

function state(): WorkflowToolbarState {
  return {
    nodes,
    edges: [],
    isExecuting: false,
    setIsExecuting: vi.fn(),
    isGenerating: false,
    clearWorkflow: vi.fn(),
    updateNodeData: vi.fn(),
    currentWorkflowId: workflowId,
    workflowName: "Workflow",
    workflowMode: "test",
    setCurrentWorkflowMode: vi.fn(),
    isOwner: true,
    isSaving: false,
    hasUnsavedChanges: true,
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: false,
    canRedo: false,
    allWorkflows: [],
    setActiveTab: vi.fn(),
    setSelectedNodeId: vi.fn(),
    userIntegrations: [],
    publication: {
      isPublished: true,
      hasUnpublishedChanges: true,
      publishedVersionId: "version_7",
      publishedVersion: 7,
      publishedAt: "2026-08-23T15:00:00.000Z",
    },
  };
}

function PublishProbe({
  workflowState = state(),
}: {
  workflowState?: WorkflowToolbarState;
}) {
  const actions = useWorkflowActions(workflowState);
  const editingLocked = useAtomValue(canvasEditingLockedAtom);
  return (
    <>
      <button onClick={actions.handlePublish} type="button">
        Start publish
      </button>
      <button onClick={actions.confirmPublish} type="button">
        Confirm publish
      </button>
      <button onClick={() => actions.setPublishReviewOpen(false)} type="button">
        Cancel review
      </button>
      <output>{actions.publishReview ? "ready" : "idle"}</output>
      <output aria-label="editing lock">{String(editingLocked)}</output>
    </>
  );
}

function NavigationPublishProbe() {
  const [workflowState, setWorkflowState] = useState(state);
  const setCurrentWorkflowId = useSetAtom(currentWorkflowIdAtom);

  return (
    <>
      <button
        onClick={() => {
          setCurrentWorkflowId("workflow_2");
          setWorkflowState({ ...state(), currentWorkflowId: "workflow_2" });
        }}
        type="button"
      >
        Open workflow 2
      </button>
      <PublishProbe workflowState={workflowState} />
    </>
  );
}

function deferred<T>() {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolveDeferred = resolvePromise;
  });
  return { promise, resolve: (value: T) => resolveDeferred(value) };
}

describe("useWorkflowActions publication preflight", () => {
  it("compares the exact editor snapshot before confirmation publishes that snapshot", async () => {
    const requests: Array<{ path: string; input: unknown }> = [];
    const queryClient = new QueryClient();
    const versionHistoryKey = orpcQuery.workflow.getVersionHistory.infiniteKey({
      input: (cursor: undefined) => ({ workflowId, cursor }),
      initialPageParam: undefined,
    });
    queryClient.setQueryData(versionHistoryKey, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        const input = await parseRpcRequestInput(init);
        requests.push({ path, input });

        if (path === "workflow/compareVersion") {
          return rpcJsonResponse({
            baseVersion: {
              id: "version_7",
              version: 7,
              publishedAt: "2026-08-23T15:00:00.000Z",
              isCurrent: true,
            },
            proposedVersion: 8,
            baseGraph: expectedSnapshot,
            draftGraph: expectedSnapshot,
            hasChanges: true,
            nodeChanges: [],
            edgeChanges: [],
          });
        }

        if (path === "workflow/publish") {
          return rpcJsonResponse({
            id: workflowId,
            name: "Workflow",
            graph: expectedSnapshot,
            isPaused: false,
            mode: "test",
            visibility: "private",
            createdAt: "2026-08-23T15:00:00.000Z",
            updatedAt: "2026-08-23T16:00:00.000Z",
            hasUnpublishedChanges: false,
            publishedVersionId: "version_8",
            publishedVersion: 8,
            publishedAt: "2026-08-23T16:00:00.000Z",
          });
        }

        throw new Error(`Unexpected RPC procedure: ${path}`);
      })
    );

    const rootRoute = createRootRoute({ component: PublishProbe });
    const view = render(
      <JotaiProvider store={workflowStore()}>
        <QueryClientProvider client={queryClient}>
          <ReactFlowProvider>
            <ExtensionCatalogProvider value={catalog}>
              <OverlayProvider>
                <RouterProvider
                  router={createRouter({
                    routeTree: rootRoute,
                    history: createMemoryHistory({ initialEntries: ["/"] }),
                  })}
                />
              </OverlayProvider>
            </ExtensionCatalogProvider>
          </ReactFlowProvider>
        </QueryClientProvider>
      </JotaiProvider>
    );

    await act(async () => {
      fireEvent.click(
        await view.findByRole("button", { name: "Start publish" })
      );
    });

    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    expect(requests).toEqual([
      {
        path: "workflow/compareVersion",
        input: {
          workflowId,
          baseVersionId: "version_7",
          draftGraph: expectedSnapshot,
        },
      },
    ]);

    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual({
      path: "workflow/publish",
      input: {
        workflowId,
        graph: expectedSnapshot,
        expectedPublishedVersionId: "version_7",
      },
    });
    await waitFor(() =>
      expect(queryClient.getQueryState(versionHistoryKey)?.isInvalidated).toBe(
        true
      )
    );
  });

  it("asks the server to compare a first publication with no base version", async () => {
    const requests: Array<{ path: string; input: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        const input = await parseRpcRequestInput(init);
        requests.push({ path, input });
        return rpcJsonResponse({
          baseVersion: null,
          proposedVersion: 1,
          baseGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
          draftGraph: expectedSnapshot,
          hasChanges: true,
          nodeChanges: [{ nodeId: "lifecycle_1", kind: "added", fields: [] }],
          edgeChanges: [],
        });
      })
    );

    const firstState = state();
    firstState.publication = {
      isPublished: false,
      hasUnpublishedChanges: false,
    };
    const rootRoute = createRootRoute({
      component: () => <PublishProbe workflowState={firstState} />,
    });
    const view = render(
      <JotaiProvider store={workflowStore()}>
        <QueryClientProvider client={new QueryClient()}>
          <ReactFlowProvider>
            <ExtensionCatalogProvider value={catalog}>
              <OverlayProvider>
                <RouterProvider
                  router={createRouter({
                    routeTree: rootRoute,
                    history: createMemoryHistory({ initialEntries: ["/"] }),
                  })}
                />
              </OverlayProvider>
            </ExtensionCatalogProvider>
          </ReactFlowProvider>
        </QueryClientProvider>
      </JotaiProvider>
    );

    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests).toEqual([
      {
        path: "workflow/compareVersion",
        input: { workflowId, draftGraph: expectedSnapshot },
      },
      {
        path: "workflow/publish",
        input: {
          workflowId,
          graph: expectedSnapshot,
          expectedPublishedVersionId: null,
        },
      },
    ]);
  });

  it("locks editing through comparison and confirmation, then unlocks on cancellation", async () => {
    const comparison = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        if (path === "workflow/compareVersion") {
          return comparison.promise;
        }
        throw new Error(`Unexpected RPC procedure: ${path}`);
      })
    );
    const store = createStore();
    store.set(currentWorkflowIdAtom, workflowId);
    const rootRoute = createRootRoute({ component: PublishProbe });
    const view = render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={new QueryClient()}>
          <ReactFlowProvider>
            <ExtensionCatalogProvider value={catalog}>
              <OverlayProvider>
                <RouterProvider
                  router={createRouter({
                    routeTree: rootRoute,
                    history: createMemoryHistory({ initialEntries: ["/"] }),
                  })}
                />
              </OverlayProvider>
            </ExtensionCatalogProvider>
          </ReactFlowProvider>
        </QueryClientProvider>
      </JotaiProvider>
    );

    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "editing lock" }).textContent
      ).toBe("true")
    );

    await act(async () => {
      comparison.resolve(
        rpcJsonResponse({
          baseVersion: {
            id: "version_7",
            version: 7,
            publishedAt: "2026-08-23T15:00:00.000Z",
            isCurrent: true,
          },
          proposedVersion: 8,
          baseGraph: expectedSnapshot,
          draftGraph: expectedSnapshot,
          hasChanges: true,
          nodeChanges: [],
          edgeChanges: [],
        })
      );
    });

    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    expect(view.getByRole("status", { name: "editing lock" }).textContent).toBe(
      "true"
    );

    fireEvent.click(view.getByRole("button", { name: "Cancel review" }));
    await waitFor(() =>
      expect(
        view.getByRole("status", { name: "editing lock" }).textContent
      ).toBe("false")
    );
  });

  it("discards a comparison response after navigating to another workflow", async () => {
    const comparison = deferred<Response>();
    const requests: Array<{ path: string; input: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = extractRpcProcedurePath(rpcUrl(url));
        const input = await parseRpcRequestInput(init);
        requests.push({ path, input });
        if (path === "workflow/compareVersion") {
          return comparison.promise;
        }
        throw new Error(`Unexpected RPC procedure: ${path}`);
      })
    );
    const store = createStore();
    store.set(currentWorkflowIdAtom, workflowId);
    const rootRoute = createRootRoute({ component: NavigationPublishProbe });
    const view = render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={new QueryClient()}>
          <ReactFlowProvider>
            <ExtensionCatalogProvider value={catalog}>
              <OverlayProvider>
                <RouterProvider
                  router={createRouter({
                    routeTree: rootRoute,
                    history: createMemoryHistory({ initialEntries: ["/"] }),
                  })}
                />
              </OverlayProvider>
            </ExtensionCatalogProvider>
          </ReactFlowProvider>
        </QueryClientProvider>
      </JotaiProvider>
    );

    fireEvent.click(await view.findByRole("button", { name: "Start publish" }));
    fireEvent.click(view.getByRole("button", { name: "Open workflow 2" }));
    await act(async () => {
      comparison.resolve(
        rpcJsonResponse({
          baseVersion: {
            id: "version_7",
            version: 7,
            publishedAt: "2026-08-23T15:00:00.000Z",
            isCurrent: true,
          },
          proposedVersion: 8,
          baseGraph: expectedSnapshot,
          draftGraph: expectedSnapshot,
          hasChanges: true,
          nodeChanges: [],
          edgeChanges: [],
        })
      );
    });

    await waitFor(() => expect(view.getByText("idle")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Confirm publish" }));
    expect(requests).toHaveLength(1);
    expect(store.get(canvasEditingLockedAtom)).toBe(false);
  });
});
