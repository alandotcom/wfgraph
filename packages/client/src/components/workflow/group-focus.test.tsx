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
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { CanvasReveal } from "#src/components/workflow/canvas-reveal/canvas-reveal";
import { RunStatusProjection } from "#src/components/workflow/run-status-projection";
import { useAddStep } from "#src/components/workflow/use-add-step";
import { WorkflowCanvas } from "#src/components/workflow/workflow-canvas";
import { WorkflowContextMenu } from "#src/components/workflow/workflow-context-menu";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { openCommandPaletteAtom } from "#src/lib/command-palette-store";
import {
  beginWorkflowComparisonRequestAtom,
  installWorkflowComparisonAtom,
  settleWorkflowComparisonRequestAtom,
} from "#src/lib/workflow-comparison-store";
import { historyAtom } from "#src/lib/workflow-graph-cells";
import {
  canvasEdgesAtom,
  canvasNodesAtom,
  copySelectionAtom,
  edgesAtom,
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { canvasIssuesByNodeIdAtom } from "#src/lib/workflow-graph-presentation-store";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import { workflowGraphUpdateAtom } from "#src/lib/workflow-ui-store";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  setWorkspaceRevealLevelAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  answerWorkflowRunRpc,
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcUrl,
  type WorkflowRunRpcFixture,
} from "#src/lib/rpc-fetch-test-support";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  WfGraphOperationIds,
  WfGraphOperations,
} from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [],
  actions: [
    {
      id: "mailer/send",
      label: "Send email",
      description: "Send one email",
      category: "Mailer",
      configFields: [],
      outputFields: [],
    },
  ],
};

function step(
  id: string,
  label: string,
  position: { x: number; y: number },
  parentId?: string
): WorkflowNode {
  const node: WorkflowNode = {
    id,
    type: "action",
    position,
    data: { label, type: "action", config: { actionType: "mailer/send" } },
  };
  return parentId
    ? { ...node, parentId, extent: "parent", draggable: false }
    : node;
}

const NODES: WorkflowNode[] = [
  {
    id: "life",
    type: "lifecycle",
    position: { x: 400, y: 0 },
    data: { label: "Patient became inactive", type: "lifecycle" },
  },
  step("qualify", "Qualification", { x: 400, y: 180 }),
  {
    id: "outreach",
    type: "group",
    position: { x: 400, y: 360 },
    width: 192,
    height: 112,
    data: { label: "Initial outreach", type: "group" },
  },
  step("welcome", "Send welcome back", { x: 12, y: 48 }, "outreach"),
  step("case_study", "Send case study", { x: 12, y: 144 }, "outreach"),
  step("route", "Route outcome", { x: 400, y: 540 }),
];

const EDGES: WorkflowEdge[] = [
  {
    id: "life-qualify",
    source: "life",
    target: "qualify",
    sourceHandle: "started",
  },
  { id: "qualify-welcome", source: "qualify", target: "welcome" },
  { id: "welcome-case", source: "welcome", target: "case_study" },
  { id: "case-route", source: "case_study", target: "route" },
];

/**
 * Two buttons a test clicks: one moves the camera to the flow origin at zoom 1,
 * and one adds a step the way the toolbar does, with no position given.
 */
function Probe() {
  const addStep = useAddStep();
  const { setViewport } = useReactFlow();
  return (
    <>
      <button
        onClick={() => void setViewport({ x: 0, y: 0, zoom: 1 })}
        type="button"
      >
        Probe origin
      </button>
      <button
        onClick={() => addStep({ actionType: "mailer/send" })}
        type="button"
      >
        Probe add step
      </button>
    </>
  );
}

async function renderEditor(
  initialSearch = "",
  graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] } = {
    nodes: NODES,
    edges: EDGES,
  },
  options: { reveal?: boolean } = {}
) {
  const store = createStore();
  store.set(workflowApiAtom, {
    update: vi.fn(async () => savedWorkflow("wf_1")),
  } as never);
  store.set(loadWorkflowGraphAtom, graph);
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(currentWorkflowNameAtom, "Patient reactivation");

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: WorkflowRouteSearch & SearchSchemaInput) =>
      authorizedWorkflowSearch(search, {
        canOpenRuns: true,
        canOpenComparison: true,
      }),
    component: () => (
      <div
        className="relative"
        data-testid="canvas-area"
        style={{ width: 1400, height: 900 }}
      >
        <WorkspaceRouteSync />
        <RunStatusProjection />
        <WorkflowCanvas canEdit />
        {options.reveal === false ? null : <CanvasReveal />}
        <Probe />
      </div>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [`/workflows/wf_1${initialSearch}`],
    }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["integration", "getAll"] as never, [] as never);

  const view = render(
    <ExtensionCatalogProvider value={catalog}>
      <IntegrationUiProvider value={{}}>
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>
            <ReactFlowProvider>
              <OverlayProvider>
                <RouterProvider router={router} />
              </OverlayProvider>
            </ReactFlowProvider>
          </JotaiProvider>
        </QueryClientProvider>
      </IntegrationUiProvider>
    </ExtensionCatalogProvider>
  );
  await view.findByTestId("canvas-area");

  const search = () => router.state.location.search;
  /** The node ids React Flow has rendered on the canvas. */
  const renderedNodeIds = () =>
    [...view.container.querySelectorAll<HTMLElement>(".react-flow__node")].map(
      (element) => element.dataset.id
    );
  const reveal = () =>
    view.container.querySelector<HTMLElement>('[data-slot="canvas-reveal"]');
  const select = async (nodeId: string) => {
    await act(async () => {
      store.set(selectOnlyNodeAtom, nodeId);
    });
  };
  return { view, store, router, search, renderedNodeIds, reveal, select };
}

beforeEach(() => {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width: 1440 });
  installAuthorizationGrantsForTests([WfGraphOperations.workflowUpdate.id]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthorizationGrantsForTests();
});

/** Run-log rows for `statuses`, one per node, in the order given. */
function logRows(statuses: Record<string, string>) {
  return Object.entries(statuses).map(([nodeId, status], index) => ({
    id: `log_${nodeId}`,
    nodeId,
    nodeName: nodeId,
    nodeType: "action",
    status,
    startedAt: `2026-03-01T10:00:0${index}.000Z`,
    completedAt: null,
    duration: null,
    error: null,
  }));
}

/** A fixture serving one run, `run_1`, with one log row per node in `statuses`. */
function serveRun(
  status: string,
  statuses: Record<string, string>
): WorkflowRunRpcFixture {
  return {
    items: [
      {
        id: "run_1",
        workflowId: "wf_1",
        workflowRunId: "inngest_1",
        status,
        startedAt: "2026-03-01T10:00:00.000Z",
        completedAt: null,
        waitingAt: null,
        cancelledAt: null,
        duration: null,
        error: null,
        entityValue: null,
        startEventName: null,
        runMode: "live",
        startSource: "event",
      },
    ],
    supersededCount: 0,
    graphs: {},
    logsSummaryExtras: {},
    logsByExecutionId: { run_1: logRows(statuses) },
    waitsByExecutionId: {},
  };
}

/** Grant every operation and answer each RPC call from `served` as it stands. */
function stubRunRpc(served: WorkflowRunRpcFixture) {
  installAuthorizationGrantsForTests(WfGraphOperationIds);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      answerWorkflowRunRpc(
        served,
        extractRpcProcedurePath(rpcUrl(input)),
        await parseRpcRequestInput(init)
      )
    )
  );
}

type EditorRouter = Awaited<ReturnType<typeof renderEditor>>["router"];

/** Pin the test graph as the run's graph and open `run_1` in Runs. */
async function openRun(
  store: ReturnType<typeof createStore>,
  router: EditorRouter
) {
  await act(async () => {
    store.set(executionOverlayGraphAtom, { nodes: NODES, edges: EDGES });
    await router.navigate({
      to: "/workflows/$workflowId",
      params: { workflowId: "wf_1" },
      search: { view: "runs", executionId: "run_1" },
    });
  });
}

async function enterOutreach(router: EditorRouter) {
  await act(async () => {
    await router.navigate({
      to: "/workflows/$workflowId",
      params: { workflowId: "wf_1" },
      search: { view: "runs", executionId: "run_1", group: "outreach" },
    });
  });
}

async function leaveOutreach(router: EditorRouter) {
  await act(async () => {
    await router.navigate({
      to: "/workflows/$workflowId",
      params: { workflowId: "wf_1" },
      search: { view: "runs", executionId: "run_1" },
    });
  });
}

/** The status chip text a step card shows, or null with no chip. */
function chipText(view: ReturnType<typeof render>, nodeId: string) {
  return (
    view
      .queryByTestId(`action-node-${nodeId}`)
      ?.querySelector('[role="status"]')?.textContent ?? null
  );
}

describe("the collapsed Group overview", () => {
  it("renders the Group as one card with its boundary edges on the frame", async () => {
    const { store, renderedNodeIds } = await renderEditor();

    await waitFor(() =>
      expect(renderedNodeIds()).toEqual(
        expect.arrayContaining(["life", "qualify", "outreach", "route"])
      )
    );
    expect(renderedNodeIds()).not.toContain("welcome");
    expect(renderedNodeIds()).not.toContain("case_study");
    expect(
      store.get(canvasEdgesAtom).map((edge) => [edge.source, edge.target])
    ).toEqual([
      ["life", "qualify"],
      ["qualify", "outreach"],
      ["outreach", "route"],
    ]);
  });

  it("opens a Group summary for the selected frame without expanding it", async () => {
    const { view, select, reveal, renderedNodeIds } = await renderEditor();
    await select("outreach");

    const region = view.getByRole("complementary", { name: "Group inspector" });
    expect(reveal()?.dataset.level).toBe("browse");
    expect(
      view.getByRole("heading", { name: "Initial outreach" })
    ).toBeTruthy();
    expect(region.querySelector("[data-slot=reveal-path]")?.textContent).toBe(
      "Patient reactivation › Initial outreach"
    );
    const steps = view.getByRole("list", { name: "Steps in this Group" });
    expect(steps.textContent).toContain("Send welcome back");
    expect(steps.textContent).toContain("Send case study");
    expect(
      view.getByRole("list", { name: "Incoming from" }).textContent
    ).toContain("Qualification");
    expect(
      view.getByRole("list", { name: "Continues to" }).textContent
    ).toContain("Route outcome");
    expect(view.getByRole("button", { name: "Enter group" })).toBeTruthy();
    expect(renderedNodeIds()).not.toContain("welcome");
  });

  it("opens a step inside the Group from the summary's step list", async () => {
    const { view, store, search, select } = await renderEditor();
    await select("outreach");

    fireEvent.click(view.getByRole("button", { name: "Send case study" }));

    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
    await waitFor(() =>
      expect(store.get(activeSelectionAtom).nodeIds).toEqual(["case_study"])
    );
    const region = await view.findByRole("complementary", {
      name: "Step inspector",
    });
    expect(region.querySelector("[data-slot=reveal-path]")?.textContent).toBe(
      "Patient reactivation › Initial outreach › Send case study"
    );
  });

  it("offers the Group's steps and Enter group in Focus", async () => {
    const { view, store, search, select, reveal } = await renderEditor();
    await select("outreach");
    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
    await waitFor(() => expect(reveal()?.dataset.level).toBe("focus"));

    const steps = view.getByRole("list", { name: "Steps in this Group" });
    expect(steps.textContent).toContain("Send welcome back");
    expect(steps.textContent).toContain("Send case study");
    expect(view.getByRole("button", { name: "Enter group" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Ungroup" })).toBeTruthy();
    expect(view.getByRole("group", { name: "Layout direction" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Send welcome back" }));
    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
    await waitFor(() =>
      expect(store.get(activeSelectionAtom).nodeIds).toEqual(["welcome"])
    );
  });

  it("counts the steps' issues in the Group's status and card badge", async () => {
    const { view, store, select } = await renderEditor();
    await act(async () => {
      store.set(workflowIssuesAtom, [
        {
          kind: "missing_required_field",
          severity: "blocking",
          nodeId: "welcome",
          nodeLabel: "Send welcome back",
          fieldKey: "to",
          fieldLabel: "To",
          message: "Send welcome back is missing To",
        },
      ]);
    });
    await select("outreach");

    const region = view.getByRole("complementary", { name: "Group inspector" });
    expect(region.querySelector("header")?.textContent).toContain("1 issue");
    expect(
      view.getByRole("button", { name: "Send welcome back, 1 issue" })
    ).toBeTruthy();
    expect(region.textContent).toContain(
      "1 issue is on a step in this Group. Choose the step to see it."
    );
    expect(store.get(canvasIssuesByNodeIdAtom).get("outreach")).toEqual({
      severity: "blocking",
      messages: ["Send welcome back is missing To"],
    });
    await waitFor(() =>
      expect(
        view
          .getByTestId("group-node-outreach")
          .querySelector('[aria-label="1 blocking issue"]')
      ).toBeTruthy()
    );
  });

  it("keeps grouping commands on the collapsed card's context menu", async () => {
    const { view, store } = await renderEditor();
    const firstMenu = render(
      <JotaiProvider store={store}>
        <ExtensionCatalogProvider value={catalog}>
          <OverlayProvider>
            <WorkflowContextMenu
              canEdit
              canInsert
              menuState={{
                type: "node",
                nodeId: "outreach",
                position: { x: 10, y: 10 },
                selectedIds: new Set(["outreach"]),
              }}
              onClose={() => undefined}
            />
          </OverlayProvider>
        </ExtensionCatalogProvider>
      </JotaiProvider>
    );
    expect(
      view.getByRole("button", { name: /Delete Group and Steps/ })
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: /Ungroup/ }));

    expect(store.get(nodesAtom).some((node) => node.id === "outreach")).toBe(
      false
    );
    expect(store.get(edgesAtom)).toEqual(EDGES);
    await waitFor(() =>
      expect(store.get(canvasNodesAtom).map((node) => node.id)).toContain(
        "welcome"
      )
    );

    firstMenu.unmount();
    // Grouping the freed steps again collapses them into a new card.
    render(
      <JotaiProvider store={store}>
        <ExtensionCatalogProvider value={catalog}>
          <OverlayProvider>
            <WorkflowContextMenu
              canEdit
              canInsert
              menuState={{
                type: "node",
                nodeId: "welcome",
                position: { x: 10, y: 10 },
                selectedIds: new Set(["welcome", "case_study"]),
              }}
              onClose={() => undefined}
            />
          </OverlayProvider>
        </ExtensionCatalogProvider>
      </JotaiProvider>
    );
    fireEvent.click(view.getByRole("button", { name: /^Group/ }));

    const canvasIds = store.get(canvasNodesAtom).map((node) => node.id);
    expect(canvasIds).not.toContain("welcome");
    expect(
      store.get(canvasNodesAtom).filter((node) => node.type === "group")
    ).toHaveLength(1);
  });

  it("enters from the card's arrow and from a double-click", async () => {
    const { view, router, search, renderedNodeIds } = await renderEditor();
    const card = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>(
        '.react-flow__node[data-id="outreach"]'
      );
      if (!element) {
        throw new Error("React Flow has not rendered the Group card");
      }
      return element;
    });

    fireEvent.click(
      view.getByRole("button", { name: "Enter group Initial outreach" })
    );
    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));

    await act(async () => {
      router.history.back();
    });
    await waitFor(() => expect(renderedNodeIds()).toContain("outreach"));
    fireEvent.doubleClick(
      view.container.querySelector<HTMLElement>(
        '.react-flow__node[data-id="outreach"]'
      ) ?? card
    );
    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
  });

  it("places a new step clear of the collapsed card alone", async () => {
    // The stored frame still has a frame-sized box, and a member's stored slot
    // sits under the canvas centre. Neither is painted on the overview.
    const nodes = NODES.map((node) => {
      if (node.id === "outreach") {
        return {
          ...node,
          position: { x: -300, y: -700 },
          width: 424,
          height: 800,
        };
      }
      return node.id === "welcome"
        ? { ...node, position: { x: 200, y: 650 } }
        : node;
    });
    const { view, store, renderedNodeIds } = await renderEditor("", {
      nodes,
      edges: EDGES,
    });
    await waitFor(() => expect(renderedNodeIds()).toContain("outreach"));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Probe origin" }));
    });

    // Happy-dom gives the pane an empty box, so the canvas centre is the
    // flow origin.
    fireEvent.click(view.getByRole("button", { name: "Probe add step" }));

    const added = store
      .get(nodesAtom)
      .find((node) => !nodes.some((item) => item.id === node.id));
    expect(added?.position).toEqual({ x: -96, y: -56 });
  });

  it("draws the collapsed card over a run's pinned graph", async () => {
    const { store, router, search } = await renderEditor();
    await act(async () => {
      store.set(executionOverlayGraphAtom, { nodes: NODES, edges: EDGES });
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: { view: "runs", executionId: "run_1" },
      });
    });
    await waitFor(() => expect(search()).toMatchObject({ view: "runs" }));

    const ids = store.get(canvasNodesAtom).map((node) => node.id);
    expect(ids).toContain("outreach");
    expect(ids).not.toContain("welcome");
  });

  it("shows a canceled run's Group status and member counts on the collapsed card", async () => {
    const served = serveRun("canceled", {
      welcome: "success",
      case_study: "running",
    });
    stubRunRpc(served);
    const { view, store, router } = await renderEditor();
    await openRun(store, router);

    const card = await view.findByTestId("group-run-summary-outreach");
    await waitFor(() => expect(card.textContent).toContain("Canceled"));
    expect(card.textContent).toContain("2 of 2 steps reached, 1 canceled");
    expect(view.getByTestId("group-node-outreach").className).toContain(
      "border-cancelled"
    );
  });

  it("updates a run's Group card from the status projection alone, in agreement with its step chips", async () => {
    const served = serveRun("running", {
      welcome: "success",
      case_study: "running",
    });
    stubRunRpc(served);
    const { view, store, router } = await renderEditor("", undefined, {
      reveal: false,
    });
    await openRun(store, router);
    expect(view.queryByTestId("runs-browse")).toBeNull();

    const card = await view.findByTestId("group-run-summary-outreach");
    await waitFor(() => expect(card.textContent).toContain("Running"));
    expect(card.textContent).toContain("2 of 2 steps reached, 1 running");
    await enterOutreach(router);
    await waitFor(() => expect(chipText(view, "case_study")).toBe("Running"));
    expect(chipText(view, "welcome")).toBe("Succeeded");

    // The run completes. Only the status poll reads it.
    served.items[0].status = "completed";
    served.logsByExecutionId.run_1 = logRows({
      welcome: "success",
      case_study: "success",
      route: "success",
    });
    await waitFor(
      () => expect(chipText(view, "case_study")).toBe("Succeeded"),
      { timeout: 3000 }
    );
    expect(chipText(view, "welcome")).toBe("Succeeded");
    await leaveOutreach(router);
    const completedCard = await view.findByTestId("group-run-summary-outreach");
    expect(completedCard.textContent).toContain("Successful");
    expect(completedCard.textContent).toContain("2 of 2 steps reached");
  });

  it.each([
    {
      runStatus: "waiting",
      card: "Waiting",
      counts: "2 of 2 steps reached, 1 waiting",
      chip: "Waiting",
      waits: [
        {
          id: "wait_1",
          nodeId: "case_study",
          nodeName: "Send case study",
          resumeToken: "tok_1",
          subscribedEvents: [],
          waitUntil: null,
        },
      ],
    },
    {
      runStatus: "failed",
      card: "Failed",
      counts: "2 of 2 steps reached, 1 failed",
      chip: "Failed",
      waits: [],
    },
  ])(
    "shows a $runStatus run's Group card and its step chip with the same status",
    async ({ runStatus, card, counts, chip, waits }) => {
      const served = serveRun(runStatus, {
        welcome: "success",
        case_study: runStatus === "failed" ? "error" : "running",
      });
      served.waitsByExecutionId = { run_1: waits };
      stubRunRpc(served);
      const { view, store, router } = await renderEditor("", undefined, {
        reveal: false,
      });
      await openRun(store, router);

      const summary = await view.findByTestId("group-run-summary-outreach");
      await waitFor(() => expect(summary.textContent).toContain(card));
      expect(summary.textContent).toContain(counts);
      await enterOutreach(router);
      await waitFor(() => expect(chipText(view, "case_study")).toBe(chip));
      expect(chipText(view, "welcome")).toBe("Succeeded");
    }
  );

  it("keeps Runs Browse on a run's focused Group canvas", async () => {
    const { view, store, router, search } = await renderEditor();
    await act(async () => {
      store.set(executionOverlayGraphAtom, { nodes: NODES, edges: EDGES });
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: { view: "runs", executionId: "run_1", group: "outreach" },
      });
    });

    await waitFor(() =>
      expect(search()).toMatchObject({ view: "runs", group: "outreach" })
    );
    const ids = store.get(canvasNodesAtom).map((node) => node.id);
    expect(ids).toEqual(expect.arrayContaining(["welcome", "case_study"]));
    expect(ids).not.toContain("outreach");
    expect(
      view.getByRole("complementary", { name: "Runs inspector" })
    ).toBeTruthy();
  });

  it("draws the collapsed card and keeps Changes Browse in both scopes", async () => {
    const { view, store, router, search } = await renderEditor();
    const graph = createSerializedWorkflowGraph({ nodes: NODES, edges: EDGES });
    const payload: WorkflowComparisonPayload = {
      baseVersion: {
        id: "version_3",
        version: 3,
        publishedAt: "2026-09-01T00:00:00.000Z",
        isCurrent: true,
      },
      proposedVersion: 4,
      baseGraph: graph,
      draftGraph: graph,
      hasChanges: true,
      nodeChanges: [{ nodeId: "welcome", kind: "modified", fields: [] }],
      edgeChanges: [],
    };
    await act(async () => {
      const epoch = store.set(beginWorkflowComparisonRequestAtom, "wf_1");
      store.set(installWorkflowComparisonAtom, {
        workflowId: "wf_1",
        epoch,
        payload,
      });
      store.set(settleWorkflowComparisonRequestAtom, {
        workflowId: "wf_1",
        epoch,
      });
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: { view: "changes", compare: "version_3" },
      });
    });

    await waitFor(() =>
      expect(store.get(canvasNodesAtom).map((node) => node.id)).toContain(
        "outreach"
      )
    );
    expect(store.get(canvasNodesAtom).map((node) => node.id)).not.toContain(
      "welcome"
    );
    expect(
      view.getByRole("complementary", { name: "Changes inspector" })
    ).toBeTruthy();

    await act(async () => {
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: { view: "changes", compare: "version_3", group: "outreach" },
      });
    });

    await waitFor(() =>
      expect(store.get(canvasNodesAtom).map((node) => node.id)).toEqual(
        expect.arrayContaining(["welcome", "case_study"])
      )
    );
    expect(search()).toMatchObject({ view: "changes", group: "outreach" });
    expect(
      view.getByRole("complementary", { name: "Changes inspector" })
    ).toBeTruthy();
  });

  it("counts changed steps on the collapsed card and enters the Group to show the first one", async () => {
    const { view, store, router, search, reveal } = await renderEditor();
    const graph = createSerializedWorkflowGraph({ nodes: NODES, edges: EDGES });
    const payload: WorkflowComparisonPayload = {
      baseVersion: {
        id: "version_3",
        version: 3,
        publishedAt: "2026-09-01T00:00:00.000Z",
        isCurrent: true,
      },
      proposedVersion: 4,
      baseGraph: graph,
      draftGraph: graph,
      hasChanges: true,
      nodeChanges: [
        { nodeId: "case_study", kind: "modified", fields: [] },
        { nodeId: "qualify", kind: "modified", fields: [] },
        { nodeId: "welcome", kind: "modified", fields: [] },
      ],
      edgeChanges: [],
    };
    await act(async () => {
      const epoch = store.set(beginWorkflowComparisonRequestAtom, "wf_1");
      store.set(installWorkflowComparisonAtom, {
        workflowId: "wf_1",
        epoch,
        payload,
      });
      store.set(settleWorkflowComparisonRequestAtom, {
        workflowId: "wf_1",
        epoch,
      });
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: { view: "changes", compare: "version_3" },
      });
    });
    await act(async () => {
      store.set(setWorkspaceRevealLevelAtom, {
        address: store.get(activeWorkspaceAddressAtom),
        level: "closed",
      });
    });
    await waitFor(() => expect(reveal()?.dataset.level).toBe("closed"));

    const marker = await view.findByRole("button", {
      name: "Show 2 changed steps in group Initial outreach",
    });
    expect(marker.textContent).toBe("2 changed");
    fireEvent.click(marker);

    await waitFor(() =>
      expect(search()).toEqual({
        view: "changes",
        compare: "version_3",
        group: "outreach",
      })
    );
    await waitFor(() =>
      expect(store.get(activeSelectionAtom)).toEqual({
        nodeIds: ["case_study"],
        edgeIds: [],
      })
    );
    expect(reveal()?.dataset.level).toBe("browse");
    expect(
      view
        .getByRole("button", { name: "Send case study Modified" })
        .getAttribute("aria-pressed")
    ).toBe("true");
  });
});

describe("the focused Group canvas", () => {
  it("enters with a pushed route, shows members and stubs, and inspects a child", async () => {
    const { view, store, router, search, select, renderedNodeIds, reveal } =
      await renderEditor();
    await select("outreach");

    fireEvent.click(view.getByRole("button", { name: "Enter group" }));

    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
    await waitFor(() =>
      expect(renderedNodeIds()).toEqual(
        expect.arrayContaining([
          "welcome",
          "case_study",
          " group-ingress:qualify",
          " group-continuation:route",
        ])
      )
    );
    expect(renderedNodeIds()).not.toContain("outreach");
    expect(renderedNodeIds()).not.toContain("qualify");
    expect(
      view.getByRole("navigation", { name: "Group" }).textContent
    ).toContain("Initial outreach");
    expect(reveal()?.dataset.level).toBe("closed");

    await select("case_study");
    const region = view.getByRole("complementary", { name: "Step inspector" });
    expect(region.querySelector("[data-slot=reveal-path]")?.textContent).toBe(
      "Patient reactivation › Initial outreach › Send case study"
    );

    // A selection outside the Group is dropped.
    await select("qualify");
    await waitFor(() =>
      expect(store.get(activeSelectionAtom).nodeIds).toEqual([])
    );

    expect(router.history.length).toBeGreaterThan(1);
  });

  it("restores each scope's selection and Reveal level through Back and Forward", async () => {
    const { view, store, router, search, select, reveal, renderedNodeIds } =
      await renderEditor();
    await select("outreach");
    fireEvent.click(view.getByRole("button", { name: "Enter group" }));
    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
    await select("welcome");
    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
    expect(reveal()?.dataset.level).toBe("focus");

    await act(async () => {
      router.history.back();
    });
    await waitFor(() => expect(search()).toEqual({}));
    await waitFor(() => expect(renderedNodeIds()).toContain("outreach"));
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["outreach"]);
    expect(reveal()?.dataset.level).toBe("browse");
    expect(
      view.getByRole("complementary", { name: "Group inspector" })
    ).toBeTruthy();

    await act(async () => {
      router.history.forward();
    });
    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
    await waitFor(() => expect(renderedNodeIds()).toContain("welcome"));
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["welcome"]);
    expect(reveal()?.dataset.level).toBe("focus");
  });

  it("leaves from the Workflow button with a pushed route", async () => {
    const { view, router, search } = await renderEditor("?group=outreach");
    const leave = await view.findByRole("button", { name: "Workflow" });

    fireEvent.click(leave);

    await waitFor(() => expect(search()).toEqual({}));
    await act(async () => {
      router.history.back();
    });
    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
  });

  it("offers no insert, paste, duplicate, or Tidy layout", async () => {
    const { view, store, select, renderedNodeIds } = await renderEditor();
    const pane = () =>
      view.container.querySelector<HTMLElement>(".react-flow__pane");
    const menuButton = (name: RegExp) => view.getByRole("button", { name });
    const closeMenu = () => fireEvent.keyDown(window, { key: "Escape" });

    // The overview offers each path, which is what the focused canvas takes away.
    await waitFor(() => expect(pane()).toBeTruthy());
    fireEvent.contextMenu(pane() as HTMLElement);
    expect(menuButton(/^Add Step/).hasAttribute("disabled")).toBe(false);
    closeMenu();

    fireEvent.click(
      await view.findByRole("button", { name: "Enter group Initial outreach" })
    );
    await waitFor(() => expect(renderedNodeIds()).toContain("welcome"));
    const stored = store.get(nodesAtom);

    fireEvent.contextMenu(pane() as HTMLElement);
    expect(menuButton(/^Add Step/).hasAttribute("disabled")).toBe(true);
    expect(menuButton(/^Paste/).hasAttribute("disabled")).toBe(true);
    closeMenu();

    const member = view.container.querySelector<HTMLElement>(
      '.react-flow__node[data-id="welcome"]'
    );
    fireEvent.contextMenu(member as HTMLElement);
    expect(menuButton(/^Duplicate/).hasAttribute("disabled")).toBe(true);
    closeMenu();

    expect(store.set(openCommandPaletteAtom, { id: "add-step" })).toBe(false);

    await select("welcome");
    await act(async () => {
      store.set(copySelectionAtom);
    });
    fireEvent.keyDown(window, { key: "v", metaKey: true });
    fireEvent.keyDown(window, { key: "d", metaKey: true });

    expect(
      view
        .getByRole("button", { name: "Reflow nodes" })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(store.get(nodesAtom)).toBe(stored);
    expect(store.get(historyAtom)).toEqual([]);
  });

  it("writes no coordinates and records no history on entry, exit, and Reveal", async () => {
    const { view, store, router, search, select } = await renderEditor();
    const positions = store.get(nodesAtom).map((node) => node.position);
    const graphUpdate = store.get(workflowGraphUpdateAtom);

    await select("outreach");
    fireEvent.click(view.getByRole("button", { name: "Enter group" }));
    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
    await select("welcome");
    await act(async () => {
      router.history.back();
    });
    await waitFor(() => expect(search()).toEqual({}));

    expect(store.get(nodesAtom).map((node) => node.position)).toEqual(
      positions
    );
    expect(
      store.get(canvasNodesAtom).some((node) => node.id === "welcome")
    ).toBe(false);
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(historyAtom)).toEqual([]);
    expect(store.get(workflowGraphUpdateAtom)).toBe(graphUpdate);
  });

  it("changes the layout direction from the Group summary as one undo step", async () => {
    const { view, store, search, select } = await renderEditor();
    await select("outreach");

    const vertical = view.getByRole("button", { name: "Top to bottom" });
    const horizontal = view.getByRole("button", { name: "Left to right" });
    expect(vertical.getAttribute("aria-pressed")).toBe("true");
    expect(horizontal.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(horizontal);

    const frame = () =>
      store.get(nodesAtom).find((node) => node.id === "outreach");
    expect(frame()?.data.config).toEqual({ direction: "horizontal" });
    expect(store.get(historyAtom)).toHaveLength(1);
    expect(store.get(edgesAtom)).toEqual(EDGES);
    await waitFor(() =>
      expect(
        view
          .getByRole("button", { name: "Left to right" })
          .getAttribute("aria-pressed")
      ).toBe("true")
    );

    fireEvent.click(view.getByRole("button", { name: "Enter group" }));
    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
    const painted = (id: string) =>
      store.get(canvasNodesAtom).find((node) => node.id === id);
    expect(painted("welcome")?.position.y).toBe(
      painted("case_study")?.position.y
    );
    expect(painted("welcome")?.position.x ?? 0).toBeLessThan(
      painted("case_study")?.position.x ?? 0
    );
  });

  it("offers interior and ingress edges for selection and deletion, and member and ingress stub handles for connection", async () => {
    const { store, renderedNodeIds } = await renderEditor("?group=outreach");
    await waitFor(() => expect(renderedNodeIds()).toContain("welcome"));

    const interior = store
      .get(canvasEdgesAtom)
      .find((edge) => edge.id === "welcome-case");
    expect(interior).toBeDefined();
    expect(interior?.selectable).not.toBe(false);
    expect(interior?.deletable).not.toBe(false);
    const ingress = store
      .get(canvasEdgesAtom)
      .find((edge) => edge.id === "qualify-welcome");
    expect(ingress?.selectable).not.toBe(false);
    expect(ingress?.deletable).not.toBe(false);
    const continuation = store
      .get(canvasEdgesAtom)
      .find((edge) => edge.id === "case-route");
    expect(continuation?.selectable).toBe(false);
    const stubs = store
      .get(canvasNodesAtom)
      .filter((node) => node.type?.startsWith("group"));
    expect(stubs.map((node) => [node.type, node.connectable])).toEqual([
      ["groupIngress", undefined],
      ["groupContinuation", false],
    ]);
    expect(
      store.get(canvasNodesAtom).find((node) => node.id === "welcome")
        ?.connectable
    ).toBeUndefined();
  });
});

describe("a Group holding a Condition whose False path ends inside it", () => {
  // `welcome` feeds the Condition `gate`. True leaves the Group for `route`,
  // and False reaches `case_study`, which ends its path inside the Group.
  const gate: WorkflowNode = {
    id: "gate",
    type: "action",
    position: { x: 12, y: 96 },
    parentId: "outreach",
    extent: "parent",
    draggable: false,
    data: {
      label: "Is reachable",
      type: "action",
      config: { actionType: BUILT_IN_ACTION_IDS.condition },
    },
  };
  const graphWith = (direction: "vertical" | "horizontal") => ({
    nodes: [
      ...NODES.map((node) =>
        node.id === "outreach"
          ? { ...node, data: { ...node.data, config: { direction } } }
          : node
      ),
      gate,
    ],
    edges: [
      EDGES[0],
      EDGES[1],
      { id: "welcome-gate", source: "welcome", target: "gate" },
      {
        id: "gate-route",
        source: "gate",
        target: "route",
        sourceHandle: "true",
      },
      {
        id: "gate-case",
        source: "gate",
        target: "case_study",
        sourceHandle: "false",
      },
    ],
  });

  it("labels each path end on the collapsed card with its step's title, within its slot", async () => {
    const graph = {
      nodes: NODES.filter((node) => node.id !== "route").map((node) =>
        node.id === "case_study"
          ? { ...node, data: { ...node.data, label: "" } }
          : node
      ),
      edges: [
        EDGES[0],
        { id: "qualify-welcome", source: "qualify", target: "welcome" },
        { id: "qualify-case", source: "qualify", target: "case_study" },
      ],
    };
    const { view, renderedNodeIds } = await renderEditor("", graph);
    await waitFor(() => expect(renderedNodeIds()).toContain("outreach"));

    const card = view.getByTestId("group-node-outreach");
    const labels = [
      ...card.querySelectorAll<HTMLElement>("[data-slot=outlet-label]"),
    ];
    expect(labels.map((label) => label.textContent)).toEqual([
      "Send welcome back",
      "Send email",
    ]);
    expect(labels.map((label) => label.title)).toEqual([
      "Send welcome back",
      "Send email",
    ]);
    expect(
      labels.map((label) => [label.style.left, label.style.maxWidth])
    ).toEqual([
      ["25%", "calc(50% - 4px)"],
      ["75%", "calc(50% - 4px)"],
    ]);
    expect(
      card.querySelector('[aria-label="Group output, Send email"]')
    ).toBeTruthy();
  });

  it("names the continuing True outlet on the collapsed card and in its summary", async () => {
    const { view, store, select, renderedNodeIds } = await renderEditor(
      "",
      graphWith("vertical")
    );
    await waitFor(() => expect(renderedNodeIds()).toContain("outreach"));

    const card = view.getByTestId("group-node-outreach");
    const outlet = card.querySelector<HTMLElement>(
      '[aria-label="Group output, True"]'
    );
    expect(outlet?.dataset.handleid).toBe("true");
    expect(card.querySelector("[data-slot=outlet-label]")?.textContent).toBe(
      "True"
    );
    expect(
      store
        .get(canvasEdgesAtom)
        .filter((edge) => edge.source === "outreach")
        .map((edge) => [edge.target, edge.sourceHandle])
    ).toEqual([["route", "true"]]);

    await select("outreach");
    expect(view.getByRole("list", { name: "Continues from" }).textContent).toBe(
      "Is reachable (True)"
    );
  });

  it.each(["vertical", "horizontal"] as const)(
    "shows where the False path ends on a %s focused canvas",
    async (direction) => {
      const { view, store, renderedNodeIds } = await renderEditor(
        "?group=outreach",
        graphWith(direction)
      );
      await waitFor(() =>
        expect(renderedNodeIds()).toEqual(
          expect.arrayContaining([
            "welcome",
            "gate",
            "case_study",
            " group-continuation:route",
            " group-end:case_study",
          ])
        )
      );
      expect(
        view.container.querySelector("[data-slot=group-end-stub]")?.textContent
      ).toBe("Path ends");
      const gateCard = view.getByTestId("action-node-gate");
      expect(
        [...gateCard.querySelectorAll("[data-slot=outlet-label]")].map(
          (label) => label.textContent
        )
      ).toEqual(["True", "False"]);
      expect(
        store
          .get(canvasEdgesAtom)
          .filter((edge) => edge.source === "gate")
          .map((edge) => [edge.target, edge.sourceHandle])
      ).toEqual([
        ["case_study", "false"],
        [" group-continuation:route", "true"],
      ]);
    }
  );
});
