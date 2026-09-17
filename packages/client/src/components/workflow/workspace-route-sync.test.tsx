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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { ExecutionOverlaySync } from "#src/components/workflow/execution-overlay-sync";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import { comparisonRevealContextAtom } from "#src/components/workflow/canvas-reveal/changes-summary";
import { useGoToStep } from "#src/hooks/use-workflow-issues";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcErrorResponse,
  rpcJsonResponse,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import {
  comparisonDisplayGraphAtom,
  comparisonSessionAtom,
  isComparisonErrorAtom,
  isComparisonPendingAtom,
} from "#src/lib/workflow-comparison-store";
import {
  displayNodesAtom,
  loadWorkflowGraphAtom,
  onNodesChangeAtom,
  presentedGraphAtom,
  presentedGraphStructureAtom,
  selectedNodeAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { selectedExecutionIdAtom } from "#src/lib/workflow-ui-store";
import {
  activeDesktopRevealLevelAtom,
  activeSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

const draftNodes: WorkflowNode[] = [
  {
    id: "draft_step",
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: "Draft step", type: "action" },
  },
  {
    id: "group_1",
    type: "group",
    position: { x: 0, y: 200 },
    width: 400,
    height: 200,
    data: { label: "Group", type: "group" },
  },
  {
    id: "child_step",
    type: "action",
    parentId: "group_1",
    position: { x: 20, y: 40 },
    data: { label: "Child step", type: "action" },
  },
  {
    id: "second_child_step",
    type: "action",
    parentId: "group_1",
    position: { x: 220, y: 40 },
    data: { label: "Second child step", type: "action" },
  },
];

function comparisonFor(base: {
  id: string;
  isCurrent: boolean;
  /** Steps the published version holds and the draft removed. */
  removedStepIds?: readonly string[] | undefined;
}): WorkflowComparisonPayload {
  const removed = base.removedStepIds ?? [];
  return {
    baseVersion: {
      id: base.id,
      version: 1,
      publishedAt: "2026-09-01T00:00:00.000Z",
      isCurrent: base.isCurrent,
    },
    proposedVersion: 2,
    baseGraph: createSerializedWorkflowGraph({
      nodes: removed.map((id) => ({
        id,
        type: "action",
        position: { x: 0, y: 0 },
        data: { label: id, type: "action" },
      })),
      edges: [],
    }),
    draftGraph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
    hasChanges: removed.length > 0,
    nodeChanges: removed.map((nodeId) => ({
      nodeId,
      kind: "removed",
      fields: [],
    })),
    edgeChanges: [],
  };
}

type HeldAnswer = "answer" | "fail";

/**
 * The server this harness answers for: the current publication, the base
 * version each comparison request named, and which ids do not exist. A base in
 * `removedStepIds` compares with those steps removed, and `hold(base)` keeps
 * that base's next answer back until the returned function releases it.
 */
function stubServer() {
  const holds = new Map<string, Promise<HeldAnswer>>();
  const server = {
    currentVersionId: "version_1",
    comparisonRequests: [] as Array<string | undefined>,
    removedStepIds: {} as Record<string, readonly string[]>,
    hold: (baseVersionId: string): ((answer: HeldAnswer) => void) => {
      let release: (answer: HeldAnswer) => void = () => undefined;
      holds.set(
        baseVersionId,
        new Promise<HeldAnswer>((resolve) => {
          release = resolve;
        })
      );
      return (answer) => release(answer);
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = extractRpcProcedurePath(rpcUrl(url));
      const input = await parseRpcRequestInput(init);
      const missing = rpcErrorResponse({
        code: "NOT_FOUND",
        status: 404,
        message: "Not found",
      });
      if (path === "workflow/compareVersion") {
        const baseVersionId =
          typeof input.baseVersionId === "string"
            ? input.baseVersionId
            : undefined;
        server.comparisonRequests.push(baseVersionId);
        if (baseVersionId === "missing") {
          return missing;
        }
        const id = baseVersionId ?? server.currentVersionId;
        const hold = holds.get(id);
        holds.delete(id);
        if (hold && (await hold) === "fail") {
          return rpcErrorResponse({
            code: "INTERNAL_SERVER_ERROR",
            status: 500,
            message: "Down",
          });
        }
        return rpcJsonResponse(
          comparisonFor({
            id,
            isCurrent: id === server.currentVersionId,
            removedStepIds: server.removedStepIds[id],
          })
        );
      }
      if (path === "workflow/getExecutionLogs") {
        // A run that exists stays loading, which is all these cases need.
        return input.executionId === "missing"
          ? missing
          : new Promise<Response>(() => undefined);
      }
      throw new Error(`Unexpected RPC ${path}`);
    })
  );
  return server;
}

function Probe() {
  const { openComparison } = useWorkflowComparisonActions();
  const navigation = useWorkflowWorkspaceNavigation(openComparison);
  const goToStep = useGoToStep();
  return (
    <>
      <button onClick={navigation.showDraft} type="button">
        Draft
      </button>
      <button onClick={navigation.showRuns} type="button">
        Runs
      </button>
      <button onClick={navigation.showChanges} type="button">
        Changes
      </button>
      <button onClick={() => goToStep("draft_step")} type="button">
        Go to step
      </button>
      <button onClick={() => goToStep("draft_step", "to")} type="button">
        Go to field
      </button>
    </>
  );
}

/**
 * The editor route as the app declares it, reduced to its search contract, the
 * two sync components, and the workspace controls.
 */
async function renderEditorRoute(initialEntry: string) {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "workflow_1");
  store.set(loadWorkflowGraphAtom, { nodes: draftNodes, edges: [] });

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (
      search: WorkflowRouteSearch & SearchSchemaInput
    ): WorkflowRouteSearch =>
      authorizedWorkflowSearch(search, {
        canOpenRuns: true,
        canOpenComparison: true,
      }),
    component: () => (
      <>
        <ExecutionOverlaySync />
        <WorkspaceRouteSync />
        <Probe />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <JotaiProvider store={store}>
        <OverlayProvider>
          <RouterProvider router={router} />
        </OverlayProvider>
      </JotaiProvider>
    </QueryClientProvider>
  );
  await view.findByRole("button", { name: "Draft" });

  const search = () => router.state.location.search;
  const click = (name: string) =>
    fireEvent.click(view.getByRole("button", { name }));
  return { router, store, search, click };
}

/** The owner's selection beside the node flags the active canvas paints. */
function selectionState(store: ReturnType<typeof createStore>) {
  return {
    owner: store.get(activeSelectionAtom).nodeIds,
    painted: store
      .get(displayNodesAtom)
      .filter((node) => node.selected)
      .map((node) => node.id),
  };
}

function selectedNodes(nodeIds: string[]) {
  return { owner: nodeIds, painted: nodeIds };
}

describe("WorkspaceRouteSync", () => {
  beforeEach(() => {
    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowCompareVersion.id,
      WfGraphOperations.workflowGetExecutionLogs.id,
    ]);
  });

  afterEach(() => {
    resetAuthorizationGrantsForTests();
    vi.unstubAllGlobals();
  });

  it("keeps the open run across a visit to Changes", async () => {
    stubServer();
    const { store, search, click } = await renderEditorRoute(
      "/workflows/workflow_1?view=runs&executionId=run_1"
    );
    await waitFor(() =>
      expect(store.get(selectedExecutionIdAtom)).toBe("run_1")
    );

    click("Changes");
    await waitFor(() =>
      expect(search()).toEqual({ view: "changes", compare: "version_1" })
    );

    click("Runs");
    await waitFor(() =>
      expect(search()).toEqual({ view: "runs", executionId: "run_1" })
    );
    expect(store.get(selectedExecutionIdAtom)).toBe("run_1");
  });

  it("pushes a history entry for each workspace and run", async () => {
    stubServer();
    const { router, search, click } = await renderEditorRoute(
      "/workflows/workflow_1"
    );
    const openRun = (executionId: string) =>
      act(() =>
        router.navigate({
          to: "/workflows/$workflowId",
          params: { workflowId: "workflow_1" },
          search: { view: "runs", executionId },
        })
      );
    const back = async (expected: WorkflowRouteSearch) => {
      await act(async () => router.history.back());
      await waitFor(() => expect(search()).toEqual(expected));
    };

    click("Runs");
    await waitFor(() => expect(search()).toEqual({ view: "runs" }));
    await openRun("run_a");
    await openRun("run_b");
    click("Changes");
    await waitFor(() =>
      expect(search()).toEqual({ view: "changes", compare: "version_1" })
    );

    await back({ view: "runs", executionId: "run_b" });
    await back({ view: "runs", executionId: "run_a" });
    await back({ view: "runs" });
    await back({});

    await act(async () => router.history.forward());
    await waitFor(() => expect(search()).toEqual({ view: "runs" }));
  });

  it("exits and re-enters a Group with Back and Forward", async () => {
    stubServer();
    const { router, store, search } = await renderEditorRoute(
      "/workflows/workflow_1"
    );
    await act(() =>
      router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "workflow_1" },
        search: { group: "group_1" },
      })
    );
    act(() => store.set(selectOnlyNodeAtom, "child_step"));
    expect(selectionState(store)).toEqual(selectedNodes(["child_step"]));

    await act(async () => router.history.back());
    await waitFor(() => expect(search()).toEqual({}));
    expect(store.get(selectedNodeAtom)).toBeNull();
    expect(selectionState(store)).toEqual(selectedNodes([]));

    await act(async () => router.history.forward());
    await waitFor(() => expect(search()).toEqual({ group: "group_1" }));
    expect(store.get(selectedNodeAtom)).toBe("child_step");
    expect(selectionState(store)).toEqual(selectedNodes(["child_step"]));
  });

  it("keeps a selection outside a focused Group while its nodes move", async () => {
    stubServer();
    const { store, search } = await renderEditorRoute(
      "/workflows/workflow_1?group=group_1"
    );
    await waitFor(() => expect(search()).toEqual({ group: "group_1" }));

    act(() => store.set(selectOnlyNodeAtom, "draft_step"));
    act(() =>
      store.set(onNodesChangeAtom, [
        {
          type: "position",
          id: "draft_step",
          position: { x: 40, y: 40 },
          dragging: true,
        },
      ])
    );

    expect(store.get(selectedNodeAtom)).toBe("draft_step");
    expect(search()).toEqual({ group: "group_1" });
  });

  it("subscribes to a graph structure a position-only change leaves alone", () => {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "workflow_1");
    store.set(loadWorkflowGraphAtom, { nodes: draftNodes, edges: [] });
    const notified = vi.fn();
    const unsubscribe = store.sub(presentedGraphStructureAtom, notified);
    const before = store.get(presentedGraphStructureAtom);
    const graphBefore = store.get(presentedGraphAtom);

    store.set(onNodesChangeAtom, [
      {
        type: "position",
        id: "draft_step",
        position: { x: 40, y: 40 },
        dragging: true,
      },
    ]);

    expect(store.get(presentedGraphAtom)).not.toBe(graphBefore);
    expect(store.get(presentedGraphStructureAtom)).toBe(before);
    expect(notified).not.toHaveBeenCalled();

    store.set(loadWorkflowGraphAtom, {
      nodes: draftNodes.filter((node) => node.id !== "draft_step"),
      edges: [],
    });

    expect(store.get(presentedGraphStructureAtom)).not.toBe(before);
    expect(notified).toHaveBeenCalled();
    unsubscribe();
  });

  it("clears a selection the graph no longer holds", async () => {
    stubServer();
    const { store } = await renderEditorRoute("/workflows/workflow_1");
    act(() => store.set(selectOnlyNodeAtom, "removed_step"));

    await waitFor(() => expect(store.get(selectedNodeAtom)).toBeNull());
  });

  it("returns a route naming a missing Group to the overview", async () => {
    stubServer();
    const { search } = await renderEditorRoute(
      "/workflows/workflow_1?group=child_step"
    );

    await waitFor(() => expect(search()).toEqual({}));
  });

  it("returns a missing run to the run list", async () => {
    stubServer();
    const { store, search } = await renderEditorRoute(
      "/workflows/workflow_1?view=runs&executionId=missing"
    );

    await waitFor(() => expect(search()).toEqual({ view: "runs" }));
    expect(store.get(selectedExecutionIdAtom)).toBeNull();
  });

  it("returns a missing comparison base to the current publication", async () => {
    const server = stubServer();
    const { search } = await renderEditorRoute(
      "/workflows/workflow_1?view=changes&compare=missing"
    );

    await waitFor(() =>
      expect(search()).toEqual({ view: "changes", compare: "version_1" })
    );
    expect(server.comparisonRequests).toEqual(["missing", undefined]);
  });

  it("settles on the retained comparison when a chosen base is missing", async () => {
    const server = stubServer();
    const { router, search } = await renderEditorRoute(
      "/workflows/workflow_1?view=changes"
    );
    await waitFor(() =>
      expect(search()).toEqual({ view: "changes", compare: "version_1" })
    );

    await act(() =>
      router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "workflow_1" },
        search: { view: "changes", compare: "missing" },
      })
    );

    await waitFor(() =>
      expect(search()).toEqual({ view: "changes", compare: "version_1" })
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(search()).toEqual({ view: "changes", compare: "version_1" });
    expect(server.comparisonRequests).toEqual([undefined, "missing"]);
  });

  it("follows a publish when the retained base was the current publication", async () => {
    const server = stubServer();
    const { search, click } = await renderEditorRoute(
      "/workflows/workflow_1?view=changes"
    );
    await waitFor(() =>
      expect(search()).toEqual({ view: "changes", compare: "version_1" })
    );

    click("Draft");
    await waitFor(() => expect(search()).toEqual({}));
    server.currentVersionId = "version_2";
    click("Changes");

    await waitFor(() =>
      expect(search()).toEqual({ view: "changes", compare: "version_2" })
    );
    expect(server.comparisonRequests.at(-1)).toBeUndefined();
  });

  it("keeps an older chosen base when returning to Changes", async () => {
    const server = stubServer();
    const { search, click } = await renderEditorRoute(
      "/workflows/workflow_1?view=changes&compare=version_0"
    );
    await waitFor(() =>
      expect(server.comparisonRequests).toEqual(["version_0"])
    );

    click("Draft");
    await waitFor(() => expect(search()).toEqual({}));
    server.currentVersionId = "version_2";
    click("Changes");

    await waitFor(() =>
      expect(server.comparisonRequests).toEqual(["version_0", "version_0"])
    );
    expect(search()).toEqual({ view: "changes", compare: "version_0" });
  });

  it("keeps the Draft selection when a comparison answers after leaving Changes", async () => {
    const server = stubServer();
    server.removedStepIds = { version_3: ["removed_step"] };
    const { router, store, search, click } = await renderEditorRoute(
      "/workflows/workflow_1"
    );
    const showChanges = (compare: string) =>
      act(() =>
        router.navigate({
          to: "/workflows/$workflowId",
          params: { workflowId: "workflow_1" },
          search: { view: "changes", compare },
        })
      );
    act(() => store.set(selectOnlyNodeAtom, "draft_step"));

    await showChanges("version_3");
    await waitFor(() =>
      expect(store.get(comparisonSessionAtom)?.payload.baseVersion?.id).toBe(
        "version_3"
      )
    );
    act(() => store.set(selectOnlyNodeAtom, "removed_step"));
    const answerVersion1 = server.hold("version_1");
    await showChanges("version_1");
    await waitFor(() =>
      expect(server.comparisonRequests).toEqual(["version_3", "version_1"])
    );
    click("Draft");
    await waitFor(() => expect(search()).toEqual({}));

    await act(async () => answerVersion1("answer"));
    await waitFor(() =>
      expect(store.get(comparisonSessionAtom)?.payload.baseVersion?.id).toBe(
        "version_1"
      )
    );
    expect(store.get(isComparisonPendingAtom)).toBe(false);
    expect(selectionState(store)).toEqual(selectedNodes(["draft_step"]));
  });

  it("drops a pending comparison for a base the route has left", async () => {
    const server = stubServer();
    const { router, store, search } = await renderEditorRoute(
      "/workflows/workflow_1?view=changes&compare=version_3"
    );
    await waitFor(() =>
      expect(store.get(comparisonRevealContextAtom).status).toBe("ready")
    );
    const answerVersion1 = server.hold("version_1");
    await act(() =>
      router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "workflow_1" },
        search: { view: "changes", compare: "version_1" },
      })
    );
    await waitFor(() =>
      expect(store.get(comparisonRevealContextAtom).status).toBe("loading")
    );
    expect(store.get(comparisonDisplayGraphAtom)).toBeNull();

    await act(async () => router.history.back());
    await waitFor(() =>
      expect(search()).toEqual({ view: "changes", compare: "version_3" })
    );
    expect(store.get(comparisonRevealContextAtom).status).toBe("ready");
    await act(async () => answerVersion1("answer"));
    await waitFor(() => expect(store.get(isComparisonPendingAtom)).toBe(false));

    expect(store.get(comparisonSessionAtom)?.payload.baseVersion?.id).toBe(
      "version_3"
    );
    expect(store.get(comparisonRevealContextAtom).status).toBe("ready");
    expect(store.get(comparisonDisplayGraphAtom)).not.toBeNull();
    expect(search()).toEqual({ view: "changes", compare: "version_3" });
    expect(server.comparisonRequests).toEqual(["version_3", "version_1"]);
  });

  it("reports no failure for a base the route has left", async () => {
    const server = stubServer();
    const { router, store, search } = await renderEditorRoute(
      "/workflows/workflow_1?view=changes&compare=version_3"
    );
    await waitFor(() =>
      expect(store.get(comparisonRevealContextAtom).status).toBe("ready")
    );
    const answerVersion1 = server.hold("version_1");
    await act(() =>
      router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "workflow_1" },
        search: { view: "changes", compare: "version_1" },
      })
    );
    await waitFor(() =>
      expect(server.comparisonRequests).toEqual(["version_3", "version_1"])
    );

    await act(async () => router.history.back());
    await waitFor(() =>
      expect(search()).toEqual({ view: "changes", compare: "version_3" })
    );
    await act(async () => answerVersion1("fail"));
    await waitFor(() => expect(store.get(isComparisonPendingAtom)).toBe(false));

    expect(store.get(isComparisonErrorAtom)).toBe(false);
    expect(store.get(comparisonRevealContextAtom).status).toBe("ready");

    // Returning to the failed base asks for it again.
    await act(async () => router.history.forward());
    await waitFor(() =>
      expect(server.comparisonRequests).toEqual([
        "version_3",
        "version_1",
        "version_1",
      ])
    );
  });

  it("goes to a Draft step from Runs with one selection", async () => {
    stubServer();
    const { router, store, search, click } = await renderEditorRoute(
      "/workflows/workflow_1"
    );
    act(() => store.set(selectOnlyNodeAtom, "child_step"));
    await act(() =>
      router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "workflow_1" },
        search: { view: "runs", executionId: "run_1" },
      })
    );
    act(() => store.set(selectOnlyNodeAtom, "run_step"));

    click("Go to step");
    await waitFor(() => expect(search()).toEqual({}));

    expect(store.get(selectedNodeAtom)).toBe("draft_step");
    expect(selectionState(store)).toEqual(selectedNodes(["draft_step"]));

    click("Runs");
    await waitFor(() =>
      expect(search()).toEqual({ view: "runs", executionId: "run_1" })
    );
    expect(store.get(selectedNodeAtom)).toBe("run_step");
  });

  it("opens Canvas Reveal in Focus for a step field an issue names", async () => {
    stubServer();
    const { store, search, click } = await renderEditorRoute(
      "/workflows/workflow_1?view=runs&executionId=run_1"
    );

    click("Go to field");
    await waitFor(() => expect(search()).toEqual({}));

    expect(store.get(selectedNodeAtom)).toBe("draft_step");
    expect(store.get(activeDesktopRevealLevelAtom)).toBe("focus");

    click("Go to step");
    expect(store.get(activeDesktopRevealLevelAtom)).toBe("focus");
  });
});
