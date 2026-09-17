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
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { CanvasReveal } from "#src/components/workflow/canvas-reveal/canvas-reveal";
import {
  MobileReveal,
  MobileRevealCovered,
} from "#src/components/workflow/canvas-reveal/mobile-reveal";
import { WorkflowCanvas } from "#src/components/workflow/workflow-canvas";
import { WorkspaceRouteSync } from "#src/components/workflow/workspace-route-sync";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { boundaryStubId } from "#src/lib/group-scope-canvas";
import { historyAtom } from "#src/lib/workflow-graph-cells";
import {
  edgesAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import type {
  WorkflowRouteSearch,
  WorldCamera,
} from "#src/lib/workflow-navigation-state";
import { authorizedWorkflowSearch } from "#src/lib/workflow-route-state";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import {
  activeMobileSheetsAtom,
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  activeWorkspaceCamerasAtom,
  recordWorkspaceCameraAtom,
} from "#src/lib/workflow-workspace-navigation";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

/** The id of the focused canvas stub standing for the outside step `qualify`. */
const INGRESS_STUB = boundaryStubId("ingress", {
  nodeId: "qualify",
  handle: null,
});

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

/** A workflow whose one Group stores the left-to-right direction. */
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
    width: 400,
    height: 112,
    data: {
      label: "Initial outreach",
      type: "group",
      config: { direction: "horizontal" },
    },
  },
  step("welcome", "Send welcome back", { x: 12, y: 48 }, "outreach"),
  step("case_study", "Send case study", { x: 212, y: 48 }, "outreach"),
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

/** Happy-dom's viewport, which the `md` media query answers from. */
function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

async function renderEditor(initialSearch = "") {
  const update = vi.fn(async (..._args: unknown[]) => savedWorkflow("wf_1"));
  const store = createStore();
  store.set(autosaveDelayAtom, 20);
  store.set(workflowApiAtom, { update } as never);
  store.set(loadWorkflowGraphAtom, { nodes: NODES, edges: EDGES });
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
      <div className="relative" data-testid="canvas-area">
        <WorkspaceRouteSync />
        <MobileRevealCovered>
          <WorkflowCanvas canEdit />
        </MobileRevealCovered>
        <CanvasReveal />
        <MobileReveal />
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
  const canvasNode = (id: string) =>
    view.container.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(id)}"]`
    );
  /** Press a canvas node the way a tap does. */
  const tapNode = async (id: string) => {
    const element = await waitFor(() => {
      const found = canvasNode(id);
      if (!found) {
        throw new Error(`node ${id} is not on the canvas`);
      }
      return found;
    });
    await act(async () => {
      fireEvent.click(element);
    });
  };
  /** The sides of the handles React Flow draws on a canvas node. */
  const handleSides = (id: string) =>
    [
      ...(canvasNode(id)?.querySelectorAll<HTMLElement>(
        ".react-flow__handle"
      ) ?? []),
    ].map((handle) => handle.dataset.handlepos);
  const sheet = () =>
    view.container.querySelector<HTMLElement>('[data-slot="mobile-reveal"]');
  const scroller = () =>
    sheet()?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
  const scrollTo = (top: number) => {
    const body = scroller();
    if (!body) {
      throw new Error("no sheet body is on screen");
    }
    body.scrollTop = top;
    fireEvent.scroll(body);
    fireEvent(body, new Event("scrollend"));
  };
  /** Record a phone camera for the active address, as a pan or a sheet does. */
  const recordCamera = (camera: WorldCamera) => {
    act(() => {
      store.set(recordWorkspaceCameraAtom, {
        address: store.get(activeWorkspaceAddressAtom),
        formFactor: "mobile",
        camera,
      });
    });
  };
  /** The phone camera the active address holds. */
  const shownCamera = () => store.get(activeWorkspaceCamerasAtom).mobile;
  const resize = async (width: number) => {
    await act(async () => {
      setViewportWidth(width);
    });
  };
  return {
    view,
    store,
    router,
    update,
    search,
    canvasNode,
    tapNode,
    handleSides,
    sheet,
    scroller,
    scrollTo,
    recordCamera,
    shownCamera,
    resize,
  };
}

beforeEach(() => {
  setViewportWidth(390);
  installAuthorizationGrantsForTests([WfGraphOperations.workflowUpdate.id]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 }))
  );
});

afterEach(() => {
  setViewportWidth(1440);
  vi.unstubAllGlobals();
  resetAuthorizationGrantsForTests();
});

describe("the mobile Draft Group sequence", () => {
  it("goes from the Workflow to the Group summary, the focused Group, and a child inspector, and Back restores each level", async () => {
    const editor = await renderEditor();
    const { view, store, router, search, sheet, scroller, scrollTo } = editor;

    // Workflow: the Group card opens its summary sheet.
    await editor.tapNode("outreach");
    const summary = view.getByRole("region", { name: "Group inspector" });
    expect(summary.dataset.level).toBe("summary");
    expect(
      within(summary).getByRole("heading", { name: "Initial outreach" })
    ).toBeTruthy();
    expect(within(summary).getByText("Left to right")).toBeTruthy();
    expect(
      within(summary).getByText(
        "On a phone, a Group's steps show top to bottom."
      )
    ).toBeTruthy();
    expect(
      within(summary).queryByRole("group", { name: "Layout direction" })
    ).toBeNull();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Initial outreach")
    );
    scrollTo(80);

    // Group summary: Enter group opens the focused Group, whose Workflow
    // control takes focus and is a finger's size.
    fireEvent.click(
      within(summary).getByRole("button", { name: /Enter group/ })
    );
    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
    await waitFor(() => expect(editor.canvasNode("welcome")).not.toBeNull());
    expect(sheet()).toBeNull();
    const leave = view.getByRole("button", { name: "Workflow" });
    expect(leave.className).toContain("max-md:h-11");
    await waitFor(() => expect(document.activeElement).toBe(leave));

    // Focused Group: a child opens its summary, whose Back names the Group.
    await editor.tapNode("case_study");
    const childSummary = view.getByRole("region", { name: "Step inspector" });
    expect(childSummary.dataset.level).toBe("summary");
    expect(
      view.getByRole("button", { name: "Back to Initial outreach" })
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Close" })).toBeNull();
    scrollTo(30);

    // Child inspector: existing configuration is edited and autosaves.
    fireEvent.click(view.getByRole("button", { name: "Open editor" }));
    expect(sheet()?.dataset.level).toBe("inspector");
    await waitFor(() => expect(scroller()?.scrollTop).toBe(0));
    fireEvent.change(view.getByLabelText("Label"), {
      target: { value: "Send the case study" },
    });
    expect(
      store.get(nodesAtom).find((node) => node.id === "case_study")?.data.label
    ).toBe("Send the case study");
    await waitFor(() => expect(editor.update).toHaveBeenCalled());
    scrollTo(60);

    // Browser Back from the inspector leaves the Group for the Workflow with
    // the Group summary at its scroll, and Forward returns to the inspector at
    // its scroll.
    await act(async () => {
      router.history.back();
    });
    await waitFor(() => expect(search()).toEqual({}));
    await waitFor(() =>
      expect(
        view.getByRole("region", { name: "Group inspector" }).dataset.level
      ).toBe("summary")
    );
    await waitFor(() => expect(scroller()?.scrollTop).toBe(80));
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["outreach"]);

    await act(async () => {
      router.history.forward();
    });
    await waitFor(() => expect(search()).toEqual({ group: "outreach" }));
    await waitFor(() => expect(sheet()?.dataset.level).toBe("inspector"));
    await waitFor(() => expect(scroller()?.scrollTop).toBe(60));
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["case_study"]);

    // Back steps down one sheet at a time to the focused Group canvas, and
    // leaves the camera where the person left it.
    const inspectorCamera = { centerX: 40, centerY: 40, zoom: 0.6 };
    editor.recordCamera(inspectorCamera);
    fireEvent.click(view.getByRole("button", { name: "Back to Summary" }));
    expect(sheet()?.dataset.level).toBe("summary");
    expect(editor.shownCamera()).toEqual(inspectorCamera);
    await waitFor(() => expect(scroller()?.scrollTop).toBe(30));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Open editor")
    );
    fireEvent.click(
      view.getByRole("button", { name: "Back to Initial outreach" })
    );
    expect(sheet()).toBeNull();
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["case_study"]);
    expect(editor.shownCamera()).toEqual(inspectorCamera);

    // Workflow returns to the overview with the Group summary, its scroll and
    // the control that entered the Group.
    fireEvent.click(view.getByRole("button", { name: "Workflow" }));
    await waitFor(() => expect(search()).toEqual({}));
    await waitFor(() =>
      expect(
        view.getByRole("region", { name: "Group inspector" }).dataset.level
      ).toBe("summary")
    );
    await waitFor(() => expect(scroller()?.scrollTop).toBe(80));
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["outreach"]);
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("Enter group")
    );

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    });
    expect(sheet()).toBeNull();
    expect(store.get(activeMobileSheetsAtom)).toEqual([]);
  });

  it("draws the focused Group top to bottom and offers no topology edit on its members or stubs", async () => {
    const editor = await renderEditor("?group=outreach");
    const { view, store } = editor;
    await waitFor(() => expect(editor.canvasNode("welcome")).not.toBeNull());
    const storedNodes = store.get(nodesAtom);
    const storedEdges = store.get(edgesAtom);

    expect(editor.handleSides("welcome")).toEqual(["top", "bottom"]);
    expect(editor.handleSides(INGRESS_STUB)).toEqual(["bottom"]);

    // No member or stub can be dragged, and the stub offers no connection.
    for (const id of ["welcome", "case_study", INGRESS_STUB]) {
      expect(editor.canvasNode(id)?.classList.contains("draggable")).toBe(
        false
      );
    }
    const stubHandle = editor
      .canvasNode(INGRESS_STUB)
      ?.querySelector<HTMLElement>(".react-flow__handle");
    expect(stubHandle?.classList.contains("connectable")).toBe(false);
    expect(stubHandle?.classList.contains("connectablestart")).toBe(false);

    // A drag from the ingress stub onto a member stores nothing.
    const memberTarget = editor
      .canvasNode("case_study")
      ?.querySelector<HTMLElement>(".react-flow__handle-top");
    await act(async () => {
      fireEvent.pointerDown(stubHandle as HTMLElement, { button: 0 });
      fireEvent.pointerMove(memberTarget as HTMLElement);
      fireEvent.pointerUp(memberTarget as HTMLElement);
    });

    // A shift-press selects one step alone.
    await editor.tapNode("welcome");
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Shift" });
      fireEvent.click(editor.canvasNode("case_study") as HTMLElement, {
        shiftKey: true,
      });
      fireEvent.keyUp(document.body, { key: "Shift" });
    });
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["case_study"]);

    expect(view.queryByRole("button", { name: "Reflow nodes" })).toBeNull();
    expect(store.get(nodesAtom)).toBe(storedNodes);
    expect(store.get(edgesAtom)).toBe(storedEdges);
    expect(store.get(historyAtom)).toEqual([]);
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
  });

  it("leaves a step's handles unconnectable on a phone, so a touch or tap on one starts no connection", async () => {
    const editor = await renderEditor();
    const { view, store } = editor;
    await waitFor(() => expect(editor.canvasNode("qualify")).not.toBeNull());
    const storedEdges = store.get(edgesAtom);
    const handles = (id: string) => [
      ...(editor
        .canvasNode(id)
        ?.querySelectorAll<HTMLElement>(".react-flow__handle") ?? []),
    ];
    for (const handle of [...handles("qualify"), ...handles("route")]) {
      expect(handle.classList.contains("connectable")).toBe(false);
      expect(handle.classList.contains("connectablestart")).toBe(false);
      expect(handle.classList.contains("connectableend")).toBe(false);
    }

    const source = handles("qualify").find(
      (handle) => handle.dataset.handlepos === "bottom"
    ) as HTMLElement;
    const target = handles("route").find(
      (handle) => handle.dataset.handlepos === "top"
    );
    await act(async () => {
      fireEvent.touchStart(source, { touches: [{ clientX: 0, clientY: 0 }] });
      fireEvent.touchMove(source, { touches: [{ clientX: 0, clientY: 90 }] });
      fireEvent.touchEnd(source);
    });
    expect(
      view.container.querySelector(".react-flow__connection-path")
    ).toBeNull();

    // Tapping one handle and then another connects nothing.
    await act(async () => {
      fireEvent.click(source);
      fireEvent.click(target as HTMLElement);
    });
    expect(source.classList.contains("clickconnecting")).toBe(false);
    expect(store.get(edgesAtom)).toBe(storedEdges);
    expect(store.get(historyAtom)).toEqual([]);
  });

  it("shows a horizontal Group left to right on desktop and top to bottom on mobile, changing nothing stored", async () => {
    setViewportWidth(1440);
    const editor = await renderEditor("?group=outreach");
    const { store } = editor;
    await waitFor(() => expect(editor.canvasNode("welcome")).not.toBeNull());
    const storedNodes = store.get(nodesAtom);
    const storedEdges = store.get(edgesAtom);
    expect(editor.handleSides("welcome")).toEqual(["left", "right"]);
    // Happy-dom's media query listener starts out believing the query does not
    // match, so the first move below `md` from a wide viewport reports no
    // change. One narrow and wide round trip puts the listener in step.
    await editor.resize(390);
    await editor.resize(1440);

    await editor.resize(390);
    await waitFor(() =>
      expect(editor.handleSides("welcome")).toEqual(["top", "bottom"])
    );

    await editor.resize(1440);
    await waitFor(() =>
      expect(editor.handleSides("welcome")).toEqual(["left", "right"])
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(store.get(nodesAtom)).toBe(storedNodes);
    expect(store.get(edgesAtom)).toBe(storedEdges);
    expect(
      store.get(nodesAtom).find((node) => node.id === "outreach")?.data.config
    ).toEqual({ direction: "horizontal" });
    expect(store.get(historyAtom)).toEqual([]);
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(editor.update).not.toHaveBeenCalled();
  });
});
