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
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import type { Store } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { DetailsPanel } from "#src/components/workflow/details/details-panel";
import { RunStatusProjection } from "#src/components/workflow/run-status-projection";
import { useAddStep } from "#src/components/workflow/use-add-step";
import { WorkflowCanvas } from "#src/components/workflow/workflow-canvas";
import { WorkflowContextMenu } from "#src/components/workflow/workflow-context-menu";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  beginPublicationReviewAtom,
  clearPublicationReviewAtom,
  installPublicationReviewAtom,
} from "#src/lib/workflow-publication-review-store";
import { reviewScrollRequestAtom } from "#src/lib/workflow-review-store";
import { historyAtom } from "#src/lib/workflow-graph-cells";
import {
  canvasEdgesAtom,
  canvasNodesAtom,
  edgesAtom,
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  selectedNodeAtom,
  selectOnlyNodeAtom,
  undoAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
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
      <button
        onClick={() =>
          addStep({
            actionType: "mailer/send",
            after: { nodeId: "route", handle: null },
          })
        }
        type="button"
      >
        Probe add step after route
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
  options: { reveal?: boolean; canEdit?: boolean } = {}
) {
  // A person without the edit grant sees the canvas read-only.
  if (options.canEdit === false) {
    installAuthorizationGrantsForTests([]);
  }
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
        canReview: true,
      }),
    component: () => (
      <div
        className="relative"
        data-testid="canvas-area"
        style={{ width: 1400, height: 900 }}
      >
        <WorkspaceRouteSync />
        <RunStatusProjection />
        <WorkflowCanvas />
        {options.reveal === false ? null : <DetailsPanel />}
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
    view.container.querySelector<HTMLElement>('[data-slot="details-panel"]');
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

describe("canvas selection", () => {
  it("replaces an existing selection when another node is clicked", async () => {
    const { store, view } = await renderEditor();

    await act(async () => {
      fireEvent.click(view.getByTestId("action-node-qualify"));
      fireEvent.click(view.getByTestId("action-node-route"));
    });

    expect(store.get(activeSelectionAtom)).toEqual({
      nodeIds: ["route"],
      edgeIds: [],
    });
  });

  it("drags a step without selecting it, opening Reveal, or moving the camera", async () => {
    const { store, view } = await renderEditor();
    const card = view.container.querySelector<HTMLElement>(
      '.react-flow__node[data-id="qualify"]'
    );
    const viewport = view.container.querySelector<HTMLElement>(
      ".react-flow__viewport"
    );
    const flowRoot = view.container.querySelector<HTMLElement>(".react-flow");
    if (!card || !viewport || !flowRoot) {
      throw new Error("the canvas did not render the Qualification card");
    }
    // happy-dom lays nothing out, and React Flow pans a drag that nears the
    // edge of its box, so the box is given its real size.
    flowRoot.getBoundingClientRect = () =>
      DOMRect.fromRect({ width: 1400, height: 900 });
    // Every camera change rewrites the viewport element's transform.
    const cameraChanges: string[] = [];
    const observer = new MutationObserver(() => {
      cameraChanges.push(viewport.style.transform);
    });
    observer.observe(viewport, {
      attributes: true,
      attributeFilter: ["style"],
    });

    // A press that moves past React Flow's one-pixel drag threshold.
    await act(async () => {
      fireEvent.mouseDown(card, {
        button: 0,
        clientX: 500,
        clientY: 300,
        view: window,
      });
      fireEvent.mouseMove(window, { clientX: 530, clientY: 330, view: window });
      fireEvent.mouseMove(window, { clientX: 560, clientY: 360, view: window });
      fireEvent.mouseUp(window, { clientX: 560, clientY: 360, view: window });
    });
    observer.disconnect();

    expect(store.get(activeSelectionAtom)).toEqual({
      nodeIds: [],
      edgeIds: [],
    });
    expect(
      view.queryByRole("complementary", { name: "Step inspector" })
    ).toBeNull();
    expect(cameraChanges).toEqual([]);
    expect(
      store.get(nodesAtom).find((node) => node.id === "qualify")?.position
    ).not.toEqual({ x: 400, y: 180 });
  });

  it("keeps keyboard focus on a card that Escape deselects", async () => {
    const { store, view } = await renderEditor();
    await act(async () => {
      fireEvent.click(view.getByTestId("action-node-qualify"));
    });
    const card = view.container.querySelector<HTMLElement>(
      '.react-flow__node[data-id="qualify"]'
    );
    if (!card) {
      throw new Error("the canvas did not render the Qualification card");
    }
    card.focus();
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["qualify"]);

    await act(async () => {
      fireEvent.keyDown(card, { key: "Escape", bubbles: true });
    });
    // React Flow blurs the card a frame after it deselects it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(store.get(activeSelectionAtom).nodeIds).toEqual([]);
    const focused = document.activeElement;
    expect(focused).not.toBe(document.body);
    expect(
      focused?.closest('.react-flow__node[data-id="qualify"]')
    ).not.toBeNull();
  });

  it("puts focus on the step a removed step followed when an undo removes it", async () => {
    const { store, view } = await renderEditor();
    await act(async () => {
      fireEvent.click(view.getByTestId("action-node-route"));
    });
    fireEvent.click(view.getByRole("button", { name: "Probe add step" }));
    const [addedId] = store.get(activeSelectionAtom).nodeIds;
    if (addedId === undefined || addedId === "route") {
      throw new Error("Add step did not select the step it added");
    }
    const card = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${addedId}"]`
      );
      if (!element) {
        throw new Error("the canvas did not render the added card");
      }
      return element;
    });
    card.focus();

    await act(async () => {
      fireEvent.keyDown(card, { key: "z", metaKey: true, bubbles: true });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(store.get(nodesAtom).some((node) => node.id === addedId)).toBe(
      false
    );
    expect(
      document.activeElement?.closest('.react-flow__node[data-id="route"]')
    ).not.toBeNull();
  });

  // The outline's "Add a step" rows name the open outlet a step joins, which
  // holds whatever the canvas has selected.
  it("adds a step on the outlet it is given, ahead of the selection", async () => {
    const { store, view } = await renderEditor();
    await act(async () => {
      fireEvent.click(view.getByTestId("action-node-qualify"));
    });
    fireEvent.click(
      view.getByRole("button", { name: "Probe add step after route" })
    );
    const [addedId] = store.get(activeSelectionAtom).nodeIds;
    expect(addedId).not.toBe("qualify");
    expect(
      store
        .get(edgesAtom)
        .filter((edge) => edge.target === addedId)
        .map((edge) => edge.source)
    ).toEqual(["route"]);
  });

  it("keeps modifier-click additive", async () => {
    const { store, view } = await renderEditor();

    fireEvent.click(view.getByTestId("action-node-qualify"));
    await waitFor(() =>
      expect(store.get(activeSelectionAtom).nodeIds).toEqual(["qualify"])
    );
    fireEvent.keyDown(window, { key: "Shift", code: "ShiftLeft" });
    fireEvent.click(view.getByTestId("action-node-route"), { shiftKey: true });
    fireEvent.keyUp(window, { key: "Shift", code: "ShiftLeft" });

    await waitFor(() =>
      expect(store.get(activeSelectionAtom)).toEqual({
        nodeIds: ["qualify", "route"],
        edgeIds: [],
      })
    );
  });
});

describe("an empty workflow", () => {
  // Each starting move has one place: what starts it in the Inspector,
  // a step from the outline's Add a step row and the start card's +, and the
  // agent from its prompt line. The canvas draws no block of its own.
  it("draws no starting block on the canvas", async () => {
    const lifecycleOnly: WorkflowNode[] = [
      {
        id: "life",
        type: "lifecycle",
        position: { x: 400, y: 0 },
        data: { label: "", type: "lifecycle" },
      },
    ];
    const { view } = await renderEditor("", {
      nodes: lifecycleOnly,
      edges: [],
    });

    await view.findByTestId("canvas-area");
    expect(
      view.queryByRole("region", { name: "Start this workflow" })
    ).toBeNull();
    expect(view.queryByRole("button", { name: "Add step" })).toBeNull();
  });
});

describe("canvas Delete gesture", () => {
  const cases = [
    {
      name: "ordinary step",
      nodeIds: ["qualify"],
      edgeIds: [],
      remainingNodes: ["life", "outreach", "welcome", "case_study", "route"],
      remainingEdges: ["welcome-case", "case-route"],
    },
    {
      name: "Group frame without its implied descendants",
      nodeIds: ["outreach"],
      edgeIds: [],
      remainingNodes: ["life", "qualify", "welcome", "case_study", "route"],
      remainingEdges: EDGES.map((edge) => edge.id),
    },
    {
      name: "painted Group edge",
      nodeIds: ["life"],
      edgeIds: ["qualify-welcome"],
      remainingNodes: NODES.map((node) => node.id),
      remainingEdges: ["life-qualify", "welcome-case", "case-route"],
    },
  ];
  for (const entry of cases) {
    it(`deletes ${entry.name} with one complete save and undo step`, async () => {
      const { store, view } = await renderEditor("", undefined, {
        reveal: false,
      });
      const before = {
        nodes: store.get(nodesAtom),
        edges: store.get(edgesAtom),
      };
      const update = vi.mocked(store.get(workflowApiAtom).update);
      await act(async () => {
        store.set(activeSelectionAtom, {
          nodeIds: entry.nodeIds,
          edgeIds: entry.edgeIds,
        });
      });
      await waitFor(() =>
        expect(
          view.container.querySelector(
            ".react-flow__node.selected, .react-flow__edge.selected"
          )
        ).not.toBeNull()
      );
      const history = store.get(historyAtom).length;
      await act(async () => {
        fireEvent.keyDown(document, { key: "Delete", code: "Delete" });
      });
      await waitFor(() => expect(update).toHaveBeenCalledOnce());
      fireEvent.keyUp(document, { key: "Delete", code: "Delete" });
      expect(
        store
          .get(nodesAtom)
          .map((node) => node.id)
          .sort()
      ).toEqual([...entry.remainingNodes].sort());
      expect(store.get(edgesAtom).map((edge) => edge.id)).toEqual(
        entry.remainingEdges
      );
      expect(store.get(historyAtom)).toHaveLength(history + 1);
      const payload = update.mock.calls[0]?.[1];
      expect(payload?.nodes?.map((node) => node.id).sort()).toEqual(
        [...entry.remainingNodes].sort()
      );
      expect(payload?.edges?.map((edge) => edge.id)).toEqual(
        entry.remainingEdges
      );
      await act(async () => {
        store.set(undoAtom);
      });
      expect(store.get(nodesAtom)).toEqual(before.nodes);
      expect(store.get(edgesAtom)).toEqual(before.edges);
    });
  }

  it("deletes the selected node while its editor is open", async () => {
    const { store, view, reveal } = await renderEditor();

    fireEvent.click(view.getByTestId("action-node-qualify"));
    await waitFor(() =>
      expect(store.get(activeSelectionAtom).nodeIds).toEqual(["qualify"])
    );
    await waitFor(() => expect(reveal()?.dataset.level).toBe("browse"));
    reveal()?.querySelector<HTMLElement>('[data-slot="reveal-title"]')?.focus();

    const focusedControl = document.activeElement;
    expect(reveal()?.contains(focusedControl)).toBe(true);
    fireEvent.keyDown(focusedControl ?? document, {
      key: "Delete",
      code: "Delete",
    });
    fireEvent.keyUp(focusedControl ?? document, {
      key: "Delete",
      code: "Delete",
    });

    await waitFor(() =>
      expect(store.get(nodesAtom).some((node) => node.id === "qualify")).toBe(
        false
      )
    );
  });

  it("leaves the node in place while typing in its editor", async () => {
    const { store, view, reveal } = await renderEditor();

    fireEvent.click(view.getByTestId("action-node-qualify"));
    await waitFor(() =>
      expect(store.get(activeSelectionAtom).nodeIds).toEqual(["qualify"])
    );
    await waitFor(() => expect(reveal()?.dataset.level).toBe("browse"));
    const label = view.getByRole("textbox", { name: "Label" });
    label.focus();

    fireEvent.keyDown(label, { key: "Delete", code: "Delete" });
    fireEvent.keyUp(label, { key: "Delete", code: "Delete" });

    expect(store.get(nodesAtom).some((node) => node.id === "qualify")).toBe(
      true
    );
  });

  it.each([
    { name: "Lifecycle-only selection", nodeId: "life", canEdit: true },
    { name: "read-only canvas", nodeId: "qualify", canEdit: false },
  ])("leaves $name unchanged", async ({ nodeId, canEdit }) => {
    const { store, view } = await renderEditor("", undefined, {
      reveal: false,
      canEdit,
    });
    const before = {
      nodes: store.get(nodesAtom),
      edges: store.get(edgesAtom),
      history: store.get(historyAtom),
    };
    await act(async () => {
      store.set(selectOnlyNodeAtom, nodeId);
    });
    await waitFor(() =>
      expect(
        view.container.querySelector(".react-flow__node.selected")
      ).not.toBeNull()
    );
    await act(async () => {
      fireEvent.keyDown(document, { key: "Delete", code: "Delete" });
      fireEvent.keyUp(document, { key: "Delete", code: "Delete" });
    });
    expect(store.get(nodesAtom)).toBe(before.nodes);
    expect(store.get(edgesAtom)).toBe(before.edges);
    expect(store.get(historyAtom)).toBe(before.history);
    expect(store.get(workflowApiAtom).update).not.toHaveBeenCalled();
  });
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
async function openRun(store: Store, router: EditorRouter) {
  await act(async () => {
    store.set(executionOverlayGraphAtom, { nodes: NODES, edges: EDGES });
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

describe("a Group drawn in place", () => {
  it("draws the Group as a region with its members as cards and connections on the members", async () => {
    const { store, view, renderedNodeIds } = await renderEditor();

    await waitFor(() =>
      expect(renderedNodeIds()).toEqual(
        expect.arrayContaining([
          "life",
          "qualify",
          "outreach",
          "welcome",
          "case_study",
          "route",
        ])
      )
    );
    expect(view.getByTestId("group-node-outreach").dataset.groupForm).toBe(
      "region"
    );
    expect(
      store.get(canvasEdgesAtom).map((edge) => [edge.source, edge.target])
    ).toEqual([
      ["life", "qualify"],
      ["qualify", "welcome"],
      ["welcome", "case_study"],
      ["case_study", "route"],
    ]);
    expect(
      store.get(canvasNodesAtom).find((node) => node.id === "welcome")
    ).toMatchObject({ parentId: "outreach", extent: "parent" });
  });

  it("selects the Group from its header and a member from its card, on the one canvas", async () => {
    const { view, store, search } = await renderEditor();
    const region = within(view.getByTestId("group-node-outreach"));

    fireEvent.click(region.getByText("Initial outreach"));
    await waitFor(() =>
      expect(store.get(activeSelectionAtom).nodeIds).toEqual(["outreach"])
    );
    expect(
      view.getByRole("complementary", { name: "Group inspector" })
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: /Enter group/ })).toBeNull();

    fireEvent.click(view.getByTestId("action-node-welcome"));
    await waitFor(() =>
      expect(store.get(activeSelectionAtom).nodeIds).toEqual(["welcome"])
    );
    expect(search()).toEqual({});
  });

  it("collapses to one card standing for its members and expands again, changing nothing stored", async () => {
    const { view, store, renderedNodeIds } = await renderEditor();
    const nodes = store.get(nodesAtom);
    const history = store.get(historyAtom);

    fireEvent.click(
      view.getByRole("button", { name: "Collapse group Initial outreach" })
    );
    await waitFor(() => expect(renderedNodeIds()).not.toContain("welcome"));
    expect(view.getByTestId("group-node-outreach").dataset.groupForm).toBe(
      "card"
    );
    expect(
      store.get(canvasEdgesAtom).map((edge) => [edge.source, edge.target])
    ).toEqual([
      ["life", "qualify"],
      ["qualify", "outreach"],
      ["outreach", "route"],
    ]);

    fireEvent.click(
      view.getByRole("button", { name: "Expand group Initial outreach" })
    );
    await waitFor(() => expect(renderedNodeIds()).toContain("welcome"));
    expect(store.get(nodesAtom)).toBe(nodes);
    expect(store.get(historyAtom)).toBe(history);
    expect(store.get(workflowApiAtom).update).not.toHaveBeenCalled();
  });

  it("keeps Collapse group, Ungroup and Delete Group and steps on the Group's context menu", async () => {
    const { view, store } = await renderEditor();
    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={new QueryClient()}>
          <ExtensionCatalogProvider value={catalog}>
            <OverlayProvider>
              <WorkflowContextMenu
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
        </QueryClientProvider>
      </JotaiProvider>
    );
    expect(
      view.getByRole("button", { name: /Delete Group and steps/ })
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: /Enter group/ })).toBeNull();
    // Collapsing is offered at every zoom, where the header's own control
    // shows only on the full card.
    expect(view.getByRole("button", { name: "Collapse group" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: /Ungroup/ }));

    expect(store.get(nodesAtom).some((node) => node.id === "outreach")).toBe(
      false
    );
    expect(store.get(edgesAtom)).toEqual(EDGES);
  });

  it("shows a run waiting inside the Group on the member and on the region's header", async () => {
    const served = serveRun("waiting", {
      welcome: "success",
      case_study: "waiting",
    });
    stubRunRpc(served);
    const { view, store, router } = await renderEditor("", undefined, {
      reveal: false,
    });
    await openRun(store, router);

    await waitFor(() => expect(chipText(view, "case_study")).toBe("Waiting"));
    expect(chipText(view, "welcome")).toBe("Completed");
    const header = await view.findByTestId("group-run-summary-outreach");
    await waitFor(() => expect(header.textContent).toContain("Waiting"));
    expect(header.textContent).toContain("2 of 2 steps reached, 1 waiting");
  });

  it("marks changed members and counts them on the region's header while the review sheet is open, with no camera move", async () => {
    const { view, store } = await renderEditor();
    const viewport = view.container.querySelector<HTMLElement>(
      ".react-flow__viewport"
    );
    if (!viewport) {
      throw new Error("the canvas did not render its viewport");
    }
    // Every camera change rewrites the viewport element's transform.
    const cameraChanges: string[] = [];
    const observer = new MutationObserver(() => {
      cameraChanges.push(viewport.style.transform);
    });
    observer.observe(viewport, {
      attributes: true,
      attributeFilter: ["style"],
    });
    const historyBefore = store.get(historyAtom);
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
      const epoch = store.set(beginPublicationReviewAtom, "wf_1");
      store.set(installPublicationReviewAtom, {
        workflowId: "wf_1",
        epoch: epoch ?? 0,
        pending: false,
        graph,
        expectedDraftRevision: 1,
        expectedPublishedVersionId: "version_3",
        payload,
      });
    });

    expect(
      (await view.findByTestId("group-changed-steps-outreach")).textContent
    ).toBe("2 changed");
    expect(
      view
        .getByTestId("action-node-welcome")
        .querySelector(".comparison-marker")?.textContent
    ).toBe("M");

    // Pressing a changed member asks the sheet for its edit and selects
    // nothing.
    await act(async () => {
      fireEvent.click(view.getByTestId("action-node-case_study"));
    });
    expect(store.get(reviewScrollRequestAtom)?.nodeId).toBe("case_study");
    expect(store.get(activeSelectionAtom)).toEqual({
      nodeIds: [],
      edgeIds: [],
    });

    await act(async () => {
      store.set(clearPublicationReviewAtom, "wf_1");
    });
    await waitFor(() =>
      expect(view.queryByTestId("group-changed-steps-outreach")).toBeNull()
    );
    observer.disconnect();
    expect(cameraChanges).toEqual([]);
    expect(store.get(historyAtom)).toBe(historyBefore);
  });

  it("draws the same one canvas on a phone", async () => {
    (
      window as unknown as {
        happyDOM: { setViewport: (viewport: { width: number }) => void };
      }
    ).happyDOM.setViewport({ width: 390 });
    const { view, renderedNodeIds } = await renderEditor("", undefined, {
      reveal: false,
    });

    await waitFor(() =>
      expect(renderedNodeIds()).toEqual(
        expect.arrayContaining(["outreach", "welcome", "case_study"])
      )
    );
    expect(view.getByTestId("group-node-outreach").dataset.groupForm).toBe(
      "region"
    );
  });
});

describe("adding a step after a step and inserting one into a connection", () => {
  const links = (store: Store) =>
    store
      .get(edgesAtom)
      .map((edge) => `${edge.source}>${edge.target}`)
      .toSorted();

  const openNodeMenu = (store: Store, nodeId: string) =>
    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={new QueryClient()}>
          <ExtensionCatalogProvider value={catalog}>
            <OverlayProvider>
              <WorkflowContextMenu
                menuState={{
                  type: "node",
                  nodeId,
                  position: { x: 10, y: 10 },
                  selectedIds: new Set([nodeId]),
                }}
                onClose={() => undefined}
              />
            </OverlayProvider>
          </ExtensionCatalogProvider>
        </QueryClientProvider>
      </JotaiProvider>
    );

  it("inserts a step before what the outlet reaches, from the overview context menu", async () => {
    const { store } = await renderEditor("", {
      nodes: NODES.filter(
        (node) => !["outreach", "welcome", "case_study"].includes(node.id)
      ),
      edges: [
        {
          id: "life-qualify",
          source: "life",
          target: "qualify",
          sourceHandle: "started",
        },
        { id: "qualify-route", source: "qualify", target: "route" },
      ],
    });

    const menu = openNodeMenu(store, "qualify");
    await act(async () => {
      fireEvent.click(menu.getByRole("button", { name: "Add step after" }));
    });

    // The source now reaches the new step, which reaches the previous target.
    const added = store.get(selectedNodeAtom);
    expect(added).toEqual(expect.any(String));
    expect(links(store)).toEqual([
      `${added}>route`,
      "life>qualify",
      `qualify>${added}`,
    ]);
  });

  it("names each outlet of a Condition it can add a step after", async () => {
    const { store } = await renderEditor("", {
      nodes: [
        ...NODES,
        {
          id: "gate",
          type: "action",
          position: { x: 800, y: 180 },
          data: {
            label: "Eligible?",
            type: "action",
            config: { actionType: BUILT_IN_ACTION_IDS.condition },
          },
        },
      ],
      edges: EDGES,
    });

    const menu = openNodeMenu(store, "gate");
    expect(
      menu.getByRole("button", { name: "Add step after True" })
    ).toBeTruthy();
    expect(
      menu.getByRole("button", { name: "Add step after False" })
    ).toBeTruthy();
  });

  it("leaves Ungroup off the menu of a step that is in no Group", async () => {
    const { store } = await renderEditor();

    const menu = openNodeMenu(store, "qualify");
    expect(menu.queryByRole("button", { name: "Ungroup" })).toBeNull();
  });

  it("inserts a step into a member's connection, inside its Group", async () => {
    const { store } = await renderEditor();

    const menu = render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={new QueryClient()}>
          <ExtensionCatalogProvider value={catalog}>
            <OverlayProvider>
              <WorkflowContextMenu
                menuState={{
                  type: "edge",
                  edgeId: "welcome-case",
                  position: { x: 10, y: 10 },
                }}
                onClose={() => undefined}
              />
            </OverlayProvider>
          </ExtensionCatalogProvider>
        </QueryClientProvider>
      </JotaiProvider>
    );
    await act(async () => {
      fireEvent.click(menu.getByRole("button", { name: "Insert step" }));
    });

    const added = store.get(selectedNodeAtom);
    expect(links(store)).toEqual([
      `${added}>case_study`,
      "case_study>route",
      "life>qualify",
      "qualify>welcome",
      `welcome>${added}`,
    ]);
    expect(
      store.get(nodesAtom).find((node) => node.id === added)?.parentId
    ).toBe("outreach");
  });
});
