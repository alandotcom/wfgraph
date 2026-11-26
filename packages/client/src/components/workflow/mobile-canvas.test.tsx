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
import { ReactFlowProvider } from "@xyflow/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { InspectorContents } from "#src/components/workflow/inspector/inspector-contents";
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
import { historyAtom } from "#src/lib/workflow-graph-cells";
import {
  edgesAtom,
  loadWorkflowGraphAtom,
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
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import {
  activeWorkspaceAddressAtom,
  activeWorkspaceCamerasAtom,
  recordWorkspaceCameraAtom,
} from "#src/lib/workflow-workspace-navigation";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { setViewportWidth } from "#src/lib/viewport-test-support";
import { showMinimapAtom } from "#src/lib/workflow-ui-store";
import { INSPECTOR_CLEARANCE_PX } from "#src/components/workflow/canvas-reveal/canvas-reveal-state";

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

/** A workflow with one Group, shown at the same stored positions on every device. */
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
      config: {},
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
        canReview: true,
      }),
    component: () => (
      <div className="relative" data-testid="canvas-area">
        <WorkspaceRouteSync />
        <MobileRevealCovered>
          <WorkflowCanvas />
        </MobileRevealCovered>
        <InspectorContents />
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

describe("the canvas on a phone", () => {
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
});

describe("the minimap", () => {
  const minimap = (view: Awaited<ReturnType<typeof renderEditor>>["view"]) =>
    view.container.querySelector<HTMLElement>(".react-flow__minimap");

  it("floats at the top right short of the Inspector's width, open or closed", async () => {
    setViewportWidth(1440);
    const editor = await renderEditor();
    act(() => {
      editor.store.set(showMinimapAtom, true);
    });
    const shown = await waitFor(() => {
      const element = minimap(editor.view);
      if (!element) {
        throw new Error("the minimap is not on the canvas");
      }
      return element;
    });
    expect(shown.classList.contains("top")).toBe(true);
    expect(shown.classList.contains("right")).toBe(true);
    expect(shown.style.marginRight).toBe(`${INSPECTOR_CLEARANCE_PX}px`);
    expect(shown.style.marginTop).toBe("36px");

    await editor.tapNode("qualify");
    expect(minimap(editor.view)?.style.marginRight).toBe(
      `${INSPECTOR_CLEARANCE_PX}px`
    );
  });

  it("keeps React Flow's side margin on a phone, which has no Inspector", async () => {
    const editor = await renderEditor();
    act(() => {
      editor.store.set(showMinimapAtom, true);
    });
    const shown = await waitFor(() => {
      const element = minimap(editor.view);
      if (!element) {
        throw new Error("the minimap is not on the canvas");
      }
      return element;
    });
    expect(shown.style.marginRight).toBe("15px");
    expect(shown.style.marginTop).toBe("36px");
  });
});
