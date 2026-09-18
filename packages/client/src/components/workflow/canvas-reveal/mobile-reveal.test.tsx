import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { Schema } from "effect";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  anEntryNode,
  anEvent,
  createEdge,
  createNode,
  startedEdge,
} from "#src/lib/upstream-node-fields-test-support";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import {
  autosaveDelayAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  hasUnsavedChangesAtom,
  workflowApiAtom,
} from "#src/lib/workflow-save-store";
import { savedWorkflow } from "#src/lib/workflow-save-test-support";
import { openMobileSheetAtom } from "#src/lib/mobile-sheet-store";
import {
  activeMobileSheetsAtom,
  activeRevealPresentationAtom,
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  recordWorkspaceCameraAtom,
  activeWorkspaceCamerasAtom,
} from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { collectWorkflowIssues } from "@wfgraph/shared/graph/workflow-issues";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import { CanvasReveal } from "./canvas-reveal";
import { MobileReveal, MobileRevealCovered } from "./mobile-reveal";

const catalog: ExtensionCatalog = {
  entities: [],
  integrations: [],
  actions: [],
  events: [
    anEvent({
      name: "app/created",
      label: "Appointment created",
      schema: Schema.Struct({ id: Schema.String }),
    }),
  ],
};

const NODES = [
  anEntryNode({ startEvents: ["app/created"] }),
  createNode({
    id: "split",
    type: "action",
    label: "Split",
    config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
  }),
  createNode({
    id: "wait",
    type: "action",
    label: "Wait 5 days",
    config: {
      actionType: BUILT_IN_ACTION_IDS.wait,
      waitMode: "delay",
      waitDuration: "5d",
    },
  }),
  createNode({
    id: "condition",
    type: "action",
    label: "Eligible?",
    config: { actionType: BUILT_IN_ACTION_IDS.condition },
  }),
];

const EDGES = [
  startedEdge("split"),
  createEdge({
    id: "e-created",
    source: "split",
    target: "wait",
    sourceHandle: eventSplitOutlet("app/created"),
  }),
  createEdge({ id: "e-condition", source: "wait", target: "condition" }),
];

function FakeCanvas() {
  return (
    <div data-testid="workflow-canvas">
      {NODES.map((node) => (
        <div
          className="react-flow__node"
          data-id={node.id}
          key={node.id}
          tabIndex={0}
        >
          {node.data.label}
        </div>
      ))}
    </div>
  );
}

/** Happy-dom's viewport, which the `md` media query answers from. */
function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

async function renderMobile() {
  const update = vi.fn(async (..._args: unknown[]) => savedWorkflow("wf_1"));
  const store = createStore();
  store.set(autosaveDelayAtom, 20);
  store.set(workflowApiAtom, { update } as never);
  store.set(loadWorkflowGraphAtom, { nodes: NODES, edges: EDGES });
  store.set(
    workflowIssuesAtom,
    collectWorkflowIssues({
      nodes: NODES,
      edges: EDGES,
      catalog,
      integrations: [],
    })
  );
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(currentWorkflowNameAtom, "Patient reactivation");
  showWorkspaceRoute(store, {});

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    component: () => (
      <div className="relative" data-testid="canvas-area">
        <MobileRevealCovered>
          <FakeCanvas />
          <button data-slot="agent-panel" type="button">
            Agent
          </button>
        </MobileRevealCovered>
        <CanvasReveal />
        <MobileReveal />
      </div>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({ initialEntries: ["/workflows/wf_1"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["integration", "getAll"] as never, [] as never);

  const view = render(
    <ExtensionCatalogProvider value={catalog}>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <ReactFlowProvider>
            <OverlayProvider>
              <RouterProvider router={router} />
            </OverlayProvider>
          </ReactFlowProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );
  await view.findByTestId("canvas-area");

  const sheet = () =>
    view.container.querySelector<HTMLElement>('[data-slot="mobile-reveal"]');
  const scroller = () =>
    sheet()?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
  const select = async (nodeId: string) => {
    await act(async () => {
      store.set(selectOnlyNodeAtom, nodeId);
    });
  };
  const scrollTo = (top: number) => {
    const body = scroller();
    if (!body) {
      throw new Error("no sheet body is on screen");
    }
    body.scrollTop = top;
    fireEvent.scroll(body);
    fireEvent(body, new Event("scrollend"));
  };
  const levels = () =>
    store.get(activeMobileSheetsAtom).map((item) => item.level);
  return { view, store, update, sheet, scroller, select, scrollTo, levels };
}

beforeEach(() => {
  setViewportWidth(390);
  installAuthorizationGrantsForTests([WfGraphOperations.workflowUpdate.id]);
});

afterEach(() => {
  setViewportWidth(1440);
  resetAuthorizationGrantsForTests();
});

describe("mobile Reveal for an ordinary step", () => {
  it("opens the summary sheet, then the full-screen inspector, and goes Back one sheet at a time", async () => {
    const { view, store, sheet, select, levels } = await renderMobile();
    expect(sheet()).toBeNull();

    await select("wait");
    expect(
      view.queryByRole("complementary", { name: "Step inspector" })
    ).toBeNull();
    const summary = view.getByRole("region", { name: "Step inspector" });
    expect(summary.dataset.level).toBe("summary");
    expect(within(summary).getByRole("heading", { name: "Wait 5 days" }));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Wait 5 days")
    );

    fireEvent.click(view.getByRole("button", { name: "Open editor" }));
    expect(sheet()?.dataset.level).toBe("inspector");
    expect(levels()).toEqual(["summary", "inspector"]);
    expect(view.getByRole("button", { name: "Back to Summary" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Back to Summary" }));
    expect(sheet()?.dataset.level).toBe("summary");

    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(sheet()).toBeNull();
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["wait"]);
  });

  it("restores each sheet's scroll on Back and keeps the desktop scroll apart", async () => {
    const { view, store, select, scroller, scrollTo } = await renderMobile();
    await select("wait");
    scrollTo(120);

    fireEvent.click(view.getByRole("button", { name: "Open editor" }));
    await waitFor(() => expect(scroller()?.scrollTop).toBe(0));
    scrollTo(60);

    fireEvent.click(view.getByRole("button", { name: "Back to Summary" }));
    await waitFor(() => expect(scroller()?.scrollTop).toBe(120));
    expect(
      store.get(activeMobileSheetsAtom).map((item) => item.scroll)
    ).toEqual([120]);
    expect(store.get(activeRevealPresentationAtom).inspectorScroll).toEqual({
      browse: 0,
      focus: 0,
    });
  });

  it("goes Back one sheet on Escape", async () => {
    const { view, sheet, select, levels } = await renderMobile();
    await select("wait");
    fireEvent.click(view.getByRole("button", { name: "Open editor" }));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    });
    expect(levels()).toEqual(["summary"]);

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    });
    expect(sheet()).toBeNull();
  });

  it("edits through the inspector and autosaves, and offers no delete", async () => {
    const { view, store, select, update } = await renderMobile();
    await select("wait");
    fireEvent.click(view.getByRole("button", { name: "Open editor" }));

    fireEvent.change(view.getByLabelText("Label"), {
      target: { value: "Wait a week" },
    });
    expect(
      store.get(nodesAtom).find((node) => node.id === "wait")?.data.label
    ).toBe("Wait a week");
    expect(store.get(hasUnsavedChangesAtom)).toBe(true);
    await waitFor(() => expect(update).toHaveBeenCalled());

    expect(view.getByRole("button", { name: "Enabled" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("mobile Reveal focus and camera", () => {
  it("returns focus on Back to the control that opened the sheet, or to the title", async () => {
    const { view, store, select } = await renderMobile();
    await select("wait");
    fireEvent.click(view.getByRole("button", { name: "Open editor" }));
    fireEvent.click(view.getByRole("button", { name: "Back to Summary" }));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Open editor")
    );

    act(() => {
      store.set(openMobileSheetAtom, {
        address: store.get(activeWorkspaceAddressAtom),
        level: "inspector",
        inspected: { kind: "node", id: "wait" },
      });
    });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Wait 5 days")
    );
    fireEvent.click(view.getByRole("button", { name: "Back to Summary" }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-slot")).toBe(
        "reveal-title"
      )
    );
  });

  it("returns focus to an Event Split's action after Back from the Lifecycle inspector", async () => {
    const { view, select } = await renderMobile();
    await select("split");
    fireEvent.click(
      view.getByRole("button", { name: "Open Lifecycle Start Events" })
    );
    fireEvent.click(view.getByRole("button", { name: "Back to Split" }));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "Open Lifecycle Start Events"
      )
    );
  });

  it("keeps Tab inside the inspector by taking the canvas and agent panel out of navigation", async () => {
    const { view, select } = await renderMobile();
    const node = () =>
      view.container.querySelector<HTMLElement>(
        '.react-flow__node[data-id="wait"]'
      );
    const agent = () => view.getByRole("button", { name: "Agent" });
    await select("wait");
    expect(node()?.closest("[inert]")).toBeNull();
    expect(agent().closest("[inert]")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Open editor" }));
    expect(node()?.closest("[inert]")).not.toBeNull();
    expect(agent().closest("[inert]")).not.toBeNull();
    const inspector = view.getByRole("region", { name: "Step inspector" });
    const reachable = [
      ...view.container.querySelectorAll<HTMLElement>(
        "button, input, textarea, [tabindex]:not([tabindex='-1'])"
      ),
    ].filter((element) => element.closest("[inert]") === null);
    expect(reachable.length).toBeGreaterThan(0);
    expect(reachable.every((element) => inspector.contains(element))).toBe(
      true
    );

    fireEvent.click(view.getByRole("button", { name: "Back to Summary" }));
    expect(agent().closest("[inert]")).toBeNull();
  });

  it("closes every sheet on Cmd+B and leaves the camera where it is", async () => {
    const { view, store, select, sheet } = await renderMobile();
    const record = (camera: {
      centerX: number;
      centerY: number;
      zoom: number;
    }) =>
      act(() => {
        store.set(recordWorkspaceCameraAtom, {
          address: store.get(activeWorkspaceAddressAtom),
          formFactor: "mobile",
          camera,
        });
      });
    await select("wait");
    record({ centerX: 5, centerY: 15, zoom: 1.2 });
    fireEvent.click(view.getByRole("button", { name: "Open editor" }));
    const shown = { centerX: 90, centerY: 90, zoom: 0.5 };
    record(shown);

    await act(async () => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });
    expect(sheet()).toBeNull();
    expect(store.get(activeMobileSheetsAtom)).toEqual([]);
    expect(store.get(activeWorkspaceCamerasAtom).mobile).toEqual(shown);
  });
});

describe("mobile Reveal for complex nodes", () => {
  it("edits a Condition's rules full screen and returns to its summary", async () => {
    const { view, sheet, select } = await renderMobile();
    await select("condition");
    expect(
      view.getByRole("region", { name: "Condition inspector" })
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Open editor" }));
    expect(sheet()?.dataset.level).toBe("inspector");
    expect(view.getByRole("region", { name: "Rule builder" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Back to Summary" }));
    expect(sheet()?.dataset.level).toBe("summary");
  });

  it("opens a Lifecycle section full screen and remembers the section", async () => {
    const { view, store, sheet, select } = await renderMobile();
    await select("lifecycle-1");

    fireEvent.click(view.getByRole("button", { name: "Edit Cancel Events" }));
    expect(sheet()?.dataset.level).toBe("inspector");
    expect(
      view
        .getByRole("button", { name: /^Cancel Events/ })
        .getAttribute("aria-current")
    ).toBe("true");
    expect(store.get(activeMobileSheetsAtom).at(-1)?.section).toBe(
      "cancel-events"
    );

    fireEvent.click(view.getByRole("button", { name: /^Connections/ }));
    expect(store.get(activeMobileSheetsAtom).at(-1)?.section).toBe(
      "connections"
    );
    expect(store.get(activeRevealPresentationAtom).inspectorSection).toBeNull();
  });

  it("jumps from an Event Split to Lifecycle Start Events and Back restores the split", async () => {
    const { view, store, sheet, select } = await renderMobile();
    await select("split");
    expect(
      view.getByRole("region", { name: "Event Split inspector" })
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Open editor" })).toBeNull();

    fireEvent.click(
      view.getByRole("button", { name: "Open Lifecycle Start Events" })
    );
    expect(sheet()?.dataset.level).toBe("inspector");
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["lifecycle-1"]);

    fireEvent.click(view.getByRole("button", { name: "Back to Split" }));
    expect(
      view.getByRole("region", { name: "Event Split inspector" })
    ).toBeTruthy();
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["split"]);
  });
});
