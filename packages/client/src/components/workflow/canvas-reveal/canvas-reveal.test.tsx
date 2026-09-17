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
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import {
  createStore,
  Provider as JotaiProvider,
  useAtomValue,
  useSetAtom,
} from "jotai";
import { type CSSProperties, type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import {
  OverlayProvider,
  useOverlay,
} from "#src/components/overlays/overlay-provider";
import { CanvasReveal } from "#src/components/workflow/canvas-reveal/canvas-reveal";
import { canvasRevealAtom } from "#src/components/workflow/canvas-reveal/canvas-reveal-state";
import {
  type RevealKind,
  revealKind,
} from "#src/components/workflow/canvas-reveal/reveal-kinds";
import { useRevealOccupiedWidth } from "#src/components/workflow/canvas-reveal/use-reveal-width";
import { WorkflowContextMenu } from "#src/components/workflow/workflow-context-menu";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { historyAtom } from "#src/lib/workflow-graph-cells";
import {
  addNodeAtom,
  clearSelectionAtom,
  displayNodesAtom,
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  onNodesChangeAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import type { WorkflowRouteSearch } from "#src/lib/workflow-navigation-state";
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
  workflowGraphUpdateAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import {
  answerWorkflowRunRpc,
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [
    {
      type: "mailer",
      label: "Mailer",
      description: "Sends email",
      credentialFields: {},
      hasTest: false,
      hasWebhook: false,
    },
  ],
  actions: [
    {
      id: "mailer/send",
      label: "Send email",
      description: "Send one email",
      category: "Mailer",
      integration: "mailer",
      configFields: [
        { key: "to", label: "To", type: "template-input", required: true },
        { key: "subject", label: "Subject", type: "template-input" },
      ],
      outputFields: [],
    },
  ],
};

function node(
  id: string,
  label: string,
  config: Record<string, unknown>,
  parentId?: string
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 100, y: 200 },
    ...(parentId ? { parentId } : {}),
    data: { label, type: "action", config },
  };
}

const NODES: WorkflowNode[] = [
  {
    id: "lifecycle",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Lifecycle", type: "lifecycle", config: {} },
  },
  node("send", "Send reminder", { actionType: "mailer/send", subject: "Hi" }),
  node("wait", "", {
    actionType: BUILT_IN_ACTION_IDS.wait,
    waitMode: "delay",
    waitDuration: "24h",
  }),
  node("condition", "Eligible?", { actionType: BUILT_IN_ACTION_IDS.condition }),
];

/** Says whether any overlay, such as the configuration sheet, is open. */
function OverlayProbe() {
  const { hasOverlays } = useOverlay();
  return hasOverlays ? <p data-testid="overlay-open" /> : null;
}

/** The viewport happy-dom answers a media query from. */
function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

/** A static stand-in for the canvas, holding one focusable node card. */
function FakeCanvas() {
  return (
    <div data-testid="workflow-canvas" tabIndex={-1}>
      <div className="react-flow__node" data-id="send" tabIndex={0}>
        Send reminder card
      </div>
    </div>
  );
}

/**
 * A canvas box publishing `--reveal-occupied-width`, the value the canvas
 * overlays beside open Reveal read, as the editor canvas publishes it.
 */
function OccupiedWidthCanvas() {
  const style: CSSProperties & Record<"--reveal-occupied-width", string> = {
    "--reveal-occupied-width": `${useRevealOccupiedWidth()}px`,
  };
  return <div data-testid="workflow-canvas" style={style} />;
}

/**
 * A real React Flow over the Draft, with its selection and delete keys wired to
 * the graph store as the editor canvas wires them, and the canvas context menu
 * opened on the pane.
 */
function FlowCanvas() {
  const nodes = useAtomValue(displayNodesAtom);
  const onNodesChange = useSetAtom(onNodesChangeAtom);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div data-testid="workflow-canvas" style={{ width: 1200, height: 800 }}>
      <ReactFlow
        deleteKeyCode={["Backspace", "Delete"]}
        edges={[]}
        nodes={nodes}
        onNodesChange={onNodesChange}
      />
      <button onClick={() => setMenuOpen(true)} type="button">
        Open canvas menu
      </button>
      <WorkflowContextMenu
        canEdit
        canInsert
        menuState={
          menuOpen
            ? {
                type: "pane",
                position: { x: 10, y: 10 },
                flowPosition: { x: 0, y: 0 },
              }
            : null
        }
        onClose={() => setMenuOpen(false)}
      />
    </div>
  );
}

async function renderReveal(
  initialSearch: WorkflowRouteSearch = {},
  options?: { selected?: string; canvas?: () => ReactNode }
) {
  const Canvas = options?.canvas ?? FakeCanvas;
  const update = vi.fn(async (..._args: unknown[]) => savedWorkflow("wf_1"));
  const store = createStore();
  store.set(autosaveDelayAtom, 20);
  store.set(workflowApiAtom, { update } as never);
  store.set(loadWorkflowGraphAtom, { nodes: NODES, edges: [] });
  store.set(currentWorkflowIdAtom, "wf_1");
  store.set(currentWorkflowNameAtom, "Appointment reminders");
  showWorkspaceRoute(store, initialSearch);
  if (options?.selected) {
    store.set(selectOnlyNodeAtom, options.selected);
  }

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
        <Canvas />
        <CanvasReveal />
        <OverlayProbe />
      </div>
    ),
  });
  const query = new URLSearchParams(
    Object.entries(initialSearch).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  ).toString();
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: [`/workflows/wf_1${query ? `?${query}` : ""}`],
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
  const aside = () =>
    view.container.querySelector<HTMLElement>('[data-slot="canvas-reveal"]');
  const level = () => aside()?.dataset.level;
  const select = async (nodeId: string) => {
    await act(async () => {
      store.set(selectOnlyNodeAtom, nodeId);
    });
  };
  const escape = async (
    target: Element = document.activeElement ?? document.body
  ) => {
    await act(async () => {
      fireEvent.keyDown(target, { key: "Escape", bubbles: true });
    });
  };
  return { view, store, router, update, aside, level, select, escape };
}

beforeEach(() => {
  setViewportWidth(1440);
  installAuthorizationGrantsForTests([WfGraphOperations.workflowUpdate.id]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = rpcUrl(input);
      return answerWorkflowRunRpc(
        {
          items: [],
          supersededCount: 0,
          graphs: {},
          logsSummaryExtras: {},
          logsByExecutionId: {},
          waitsByExecutionId: {},
        },
        extractRpcProcedurePath(url),
        await parseRpcRequestInput(init)
      );
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthorizationGrantsForTests();
});

describe("Canvas Reveal presentation states", () => {
  it("rests closed and offers no resize control", async () => {
    const { view, level } = await renderReveal();
    expect(level()).toBe("closed");
    expect(view.queryByRole("separator")).toBeNull();
    expect(view.queryByLabelText("Open inspector")).toBeNull();
  });

  it("publishes the width open Canvas Reveal covers on the canvas box", async () => {
    const { view, select } = await renderReveal(
      {},
      { canvas: OccupiedWidthCanvas }
    );
    const occupied = () =>
      view
        .getByTestId("workflow-canvas")
        .style.getPropertyValue("--reveal-occupied-width");
    expect(occupied()).toBe("0px");

    await select("send");

    await waitFor(() => expect(occupied()).toMatch(/^[1-9]\d*px$/));
  });

  it("opens Browse with the workspace, step, path, and status for an Action", async () => {
    const { view, level, select, store } = await renderReveal();
    await select("send");

    expect(level()).toBe("browse");
    const region = view.getByRole("complementary", { name: "Step inspector" });
    expect(region.textContent).toContain("Draft");
    expect(view.getByRole("heading", { name: "Send reminder" })).toBeTruthy();
    expect(region.querySelector("[data-slot=reveal-path]")?.textContent).toBe(
      "Appointment reminders › Send reminder"
    );
    expect(region.textContent).toContain("Ready");
    expect(region.textContent).toContain("Mailer · Send email");
    expect(region.textContent).toContain("Not set");
    expect(region.textContent).toContain("Subject");

    await act(async () => {
      store.set(workflowIssuesAtom, [
        {
          kind: "missing_required_field",
          severity: "blocking",
          nodeId: "send",
          nodeLabel: "Send reminder",
          fieldKey: "to",
          fieldLabel: "To",
          message: "To is required.",
        },
      ]);
    });
    expect(region.textContent).toContain("1 issue");
    expect(view.getByRole("button", { name: "To is required." })).toBeTruthy();
  });

  it("opens Browse for a Wait with its timing summary", async () => {
    const { view, select } = await renderReveal();
    await select("wait");

    const region = view.getByRole("complementary", { name: "Step inspector" });
    expect(view.getByRole("heading", { name: "Wait" })).toBeTruthy();
    expect(region.textContent).toContain("Wait for time");
    expect(region.textContent).toContain("24h");
    expect(view.getByRole("button", { name: "Focus editor" })).toBeTruthy();
  });

  it("opens the Condition inspector at Browse for a Condition, with Focus", async () => {
    const { view, level, select } = await renderReveal();
    await select("condition");

    expect(level()).toBe("browse");
    expect(
      view.getByRole("complementary", { name: "Condition inspector" })
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "Focus editor" })).toBeTruthy();
    expect(view.queryByTestId("properties-panel")).toBeNull();
  });
});

describe("Canvas Reveal editing", () => {
  it("keeps Browse and Focus edits through level changes in one autosave", async () => {
    const { view, store, update, select, level } = await renderReveal();
    await select("send");

    fireEvent.change(view.getByLabelText("Label"), {
      target: { value: "Send confirmation" },
    });
    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
    expect(level()).toBe("focus");
    fireEvent.change(view.getByLabelText("Description"), {
      target: { value: "The day before" },
    });
    expect((view.getByLabelText("Label") as HTMLInputElement).value).toBe(
      "Send confirmation"
    );
    fireEvent.click(view.getByRole("button", { name: "Return to summary" }));
    expect(level()).toBe("browse");

    const saved = store.get(nodesAtom).find((item) => item.id === "send");
    expect(saved?.data).toMatchObject({
      label: "Send confirmation",
      description: "The day before",
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const payload = JSON.stringify(update.mock.calls[0]);
    expect(payload).toContain("Send confirmation");
    expect(payload).toContain("The day before");
  });

  it("opens Focus on the field an issue names", async () => {
    const { view, store, select, level } = await renderReveal();
    await select("send");
    await act(async () => {
      store.set(workflowIssuesAtom, [
        {
          kind: "missing_required_field",
          severity: "blocking",
          nodeId: "send",
          nodeLabel: "Send reminder",
          fieldKey: "to",
          fieldLabel: "To",
          message: "To is required.",
        },
      ]);
    });

    fireEvent.click(view.getByRole("button", { name: "To is required." }));
    expect(level()).toBe("focus");
    await waitFor(() => expect(document.activeElement?.id).toBe("to"));
  });

  it("never lays out, moves, dirties, or records history while revealing", async () => {
    const { view, store, select, escape } = await renderReveal();
    const positions = store.get(nodesAtom).map((item) => item.position);
    const graphUpdate = store.get(workflowGraphUpdateAtom);

    await select("send");
    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
    await escape();
    await escape();

    expect(store.get(nodesAtom).map((item) => item.position)).toEqual(
      positions
    );
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(historyAtom)).toEqual([]);
    expect(store.get(workflowGraphUpdateAtom)).toBe(graphUpdate);
  });
});

describe("Canvas Reveal keyboard and focus", () => {
  it("unwinds Focus to Browse to Closed and returns focus to each opener", async () => {
    const { view, store, select, escape, level } = await renderReveal();
    const card = view.getByText("Send reminder card");
    card.focus();
    await select("send");
    expect(document.activeElement).toBe(card);

    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
    expect(document.activeElement).toBe(
      view.getByRole("heading", { name: "Send reminder" })
    );

    await escape();
    expect(level()).toBe("browse");
    expect(document.activeElement).toBe(
      view.getByRole("button", { name: "Focus editor" })
    );

    await escape();
    expect(level()).toBe("closed");
    expect(document.activeElement).toBe(card);
    expect(store.get(activeSelectionAtom)).toEqual({
      nodeIds: ["send"],
      edgeIds: [],
    });
  });

  it("moves focus without scrolling while Reveal slides in and out", async () => {
    // A focus that scrolls reaches for Reveal while it still sits past the
    // canvas edge and drags the editor shell sideways, toolbar and all. happy-dom
    // does not scroll, so this holds the two things that prevent it: every focus
    // Reveal moves passes `preventScroll`, and Reveal clips its overflow.
    const { view, store, escape, level, aside } = await renderReveal();
    const card = view.getByText("Send reminder card");
    card.focus();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      await act(async () => {
        store.set(addNodeAtom, node("new", "", {}));
      });
      expect(level()).toBe("browse");
      const search = view.getByPlaceholderText("Search actions...");
      expect(document.activeElement).toBe(search);

      await escape();
      expect(level()).toBe("closed");

      await act(async () => {
        store.set(selectOnlyNodeAtom, "send");
      });
      fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
      expect(document.activeElement).toBe(
        view.getByRole("heading", { name: "Send reminder" })
      );
      await escape();
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: "Focus editor" })
      );

      expect(focus.mock.calls.length).toBeGreaterThanOrEqual(4);
      for (const call of focus.mock.calls) {
        expect(call).toEqual([{ preventScroll: true }]);
      }
    } finally {
      focus.mockRestore();
    }
    expect(aside()?.classList.contains("overflow-clip")).toBe(true);
    expect(aside()?.classList.contains("overflow-hidden")).toBe(false);
  });

  it("unwinds one level for each Back", async () => {
    const { view, select, level } = await renderReveal();
    await select("send");
    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));

    fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(level()).toBe("browse");
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(level()).toBe("closed");
  });

  it("runs the kind's own unwind for both Back and Escape", async () => {
    const { view, store, select, escape, level } = await renderReveal();
    await select("send");
    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
    const { subject } = store.get(canvasRevealAtom);
    if (!subject) {
      throw new Error("no Reveal subject for the selected step");
    }
    // A stub unwind on the step kind that records each call and moves nothing.
    // The kind object is shared by every file in this worker, so the `finally`
    // block puts the step kind's own unwind back.
    const kind = revealKind(subject);
    const ownUnwind = kind.unwind;
    if (!ownUnwind) {
      throw new Error("the step kind has no unwind to stub");
    }
    const unwind = vi.fn<NonNullable<RevealKind["unwind"]>>();
    kind.unwind = unwind;
    try {
      fireEvent.click(view.getByRole("button", { name: "Back" }));
      await escape();
      expect(level()).toBe("focus");
      expect(unwind).toHaveBeenCalledTimes(2);
      expect(unwind.mock.calls.map(([input]) => input.level)).toEqual([
        "focus",
        "focus",
      ]);
      expect(unwind.mock.calls[1]?.[0].subject).toBe(subject);

      await act(async () => {
        unwind.mock.calls[1]?.[0].unwindLevel();
      });
      expect(level()).toBe("browse");
    } finally {
      kind.unwind = ownUnwind;
    }
  });

  it("reopens a closed Reveal at the level it was closed from", async () => {
    const { view, store, select, level } = await renderReveal();
    await select("send");
    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(level()).toBe("closed");
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["send"]);

    await act(async () => {
      store.set(clearSelectionAtom);
    });
    await select("wait");
    expect(level()).toBe("focus");

    fireEvent.click(view.getByRole("button", { name: "Close" }));
    fireEvent.click(view.getByLabelText("Open inspector"));
    expect(level()).toBe("focus");
  });

  it("leaves Escape to a control that holds a popup open", async () => {
    const { view, select, escape, level } = await renderReveal();
    await select("send");
    const label = view.getByLabelText("Label");
    label.setAttribute("aria-expanded", "true");

    await escape(label);
    expect(level()).toBe("browse");

    label.removeAttribute("aria-expanded");
    await escape(label);
    expect(level()).toBe("closed");
  });

  it("leaves Escape to an open Select in Focus", async () => {
    const { view, select, escape, level } = await renderReveal();
    await select("wait");
    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));

    fireEvent.click(
      await view.findByRole("combobox", { name: "How should this step wait?" })
    );
    const option = await view.findByRole("option", { name: "Wait for time" });
    await escape(option);
    expect(level()).toBe("focus");
  });

  it("leaves Escape alone outside the canvas", async () => {
    const { select, escape, level } = await renderReveal();
    await select("send");
    const outside = document.createElement("button");
    document.body.append(outside);

    await escape(outside);
    expect(level()).toBe("browse");
    outside.remove();
  });
});

describe("Canvas Reveal navigation state", () => {
  it("restores the Focus level, step, and inspector scroll per scope", async () => {
    const { view, store, select, aside, level } = await renderReveal();
    await select("send");
    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
    expect(level()).toBe("focus");

    const scroller = () =>
      aside()?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
    const body = scroller();
    if (!body) {
      throw new Error("the Focus body did not render");
    }
    body.scrollTop = 140;
    fireEvent.scroll(body);
    fireEvent(body, new Event("scrollend"));

    await act(async () => {
      showWorkspaceRoute(store, { view: "runs" });
    });
    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");
    await act(async () => {
      showWorkspaceRoute(store, {});
    });

    expect(level()).toBe("focus");
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["send"]);
    await waitFor(() => expect(scroller()?.scrollTop).toBe(140));
  });
});

describe("Canvas Reveal in Runs", () => {
  async function renderRuns() {
    const rendered = await renderReveal({
      view: "runs",
      executionId: "exec_1",
    });
    await act(async () => {
      rendered.store.set(executionOverlayGraphAtom, {
        nodes: [NODES[0]],
        edges: [],
      });
    });
    return rendered;
  }

  it("closes and reopens Canvas Reveal in Runs from the header and Cmd+B, keeping the run", async () => {
    const { view, store, router, level } = await renderRuns();
    await waitFor(() => expect(level()).toBe("browse"));

    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(level()).toBe("closed");
    expect(store.get(workflowWorkspaceViewAtom)).toBe("runs");

    await act(async () => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });
    expect(level()).toBe("browse");
    await act(async () => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });
    expect(level()).toBe("closed");
    expect(router.state.location.search).toEqual({
      view: "runs",
      executionId: "exec_1",
    });
  });

  it("keeps the closed panel mounted and inert", async () => {
    const { view, aside, level } = await renderRuns();
    await waitFor(() => expect(level()).toBe("browse"));
    fireEvent.click(view.getByRole("button", { name: "Close" }));

    expect(aside()?.hasAttribute("inert")).toBe(true);
    expect(aside()?.querySelector('[data-testid="runs-browse"]')).toBeTruthy();
  });
});

describe("Canvas Reveal on a narrow viewport", () => {
  afterEach(() => setViewportWidth(1440));

  it("leaves a selected Draft step to the mobile Reveal sequence", async () => {
    setViewportWidth(500);
    const { view, aside } = await renderReveal({}, { selected: "send" });

    expect(aside()).toBeNull();
    expect(view.queryByTestId("overlay-open")).toBeNull();
  });
});

describe("Canvas Reveal over a React Flow canvas", () => {
  const flow = { canvas: FlowCanvas };

  it("keeps the step when Backspace or Delete is pressed on a control inside Reveal", async () => {
    const { view, store, select } = await renderReveal({}, flow);
    await select("send");
    const toggle = view.getByRole("button", { name: "Focus editor" });
    toggle.focus();

    await act(async () => {
      fireEvent.keyDown(toggle, { key: "Backspace", bubbles: true });
      fireEvent.keyDown(toggle, { key: "Delete", bubbles: true });
    });

    expect(store.get(nodesAtom).some((item) => item.id === "send")).toBe(true);
  });

  it("closes on Escape from the focused node and keeps its selection", async () => {
    const { view, store, select, level } = await renderReveal({}, flow);
    await select("send");
    const card = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>(
        '.react-flow__node[data-id="send"]'
      );
      if (!element) {
        throw new Error("React Flow has not rendered the node");
      }
      return element;
    });
    card.focus();

    await act(async () => {
      fireEvent.keyDown(card, { key: "Escape", bubbles: true });
    });

    expect(level()).toBe("closed");
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["send"]);
  });

  it("leaves Escape to an open canvas context menu", async () => {
    const { view, select, escape, level } = await renderReveal({}, flow);
    await select("send");
    fireEvent.click(view.getByRole("button", { name: "Open canvas menu" }));
    expect(view.getByRole("button", { name: /Add Step/ })).toBeTruthy();

    await escape(document.body);

    expect(view.queryByRole("button", { name: /Add Step/ })).toBeNull();
    expect(level()).toBe("browse");
  });
});

describe("Canvas Reveal subjects and focus return", () => {
  it("returns focus to the node that opened the current subject", async () => {
    const { view, store, escape, level } = await renderReveal();
    const canvas = view.getByTestId("workflow-canvas");
    const second = document.createElement("div");
    second.className = "react-flow__node";
    second.dataset.id = "wait";
    second.tabIndex = 0;
    canvas.append(second);

    view.getByText("Send reminder card").focus();
    await act(async () => {
      store.set(selectOnlyNodeAtom, "send");
    });
    second.focus();
    await act(async () => {
      store.set(selectOnlyNodeAtom, "wait");
    });

    view.getByRole("button", { name: "Close" }).focus();
    await escape();
    expect(level()).toBe("closed");
    expect(document.activeElement).toBe(second);
  });

  it("falls back to the subject's node when the opener is gone", async () => {
    const { view, store, level } = await renderReveal();
    const opener = document.createElement("button");
    view.getByTestId("workflow-canvas").append(opener);
    opener.focus();
    await act(async () => {
      store.set(selectOnlyNodeAtom, "send");
    });
    opener.remove();

    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(level()).toBe("closed");
    expect(document.activeElement).toBe(view.getByText("Send reminder card"));
  });

  it("gives the run list a header with its title and Close and no Back", async () => {
    const { view, store, level } = await renderReveal({ view: "runs" });
    await act(async () => {
      store.set(executionOverlayGraphAtom, { nodes: [NODES[0]], edges: [] });
    });
    await waitFor(() => expect(level()).toBe("browse"));

    expect(view.getByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("keeps the scroll of a field an issue focused over the stored scroll", async () => {
    const { view, store, select, aside, level } = await renderReveal();
    await select("send");
    await act(async () => {
      store.set(workflowIssuesAtom, [
        {
          kind: "missing_required_field",
          severity: "blocking",
          nodeId: "send",
          nodeLabel: "Send reminder",
          fieldKey: "to",
          fieldLabel: "To",
          message: "To is required.",
        },
      ]);
    });
    const scrollIntoView = vi.fn(function (this: HTMLElement) {
      const body = this.closest<HTMLElement>(".overflow-y-auto");
      if (body) {
        body.scrollTop = 320;
      }
    });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
      scrollIntoView
    );

    fireEvent.click(view.getByRole("button", { name: "To is required." }));
    expect(level()).toBe("focus");
    await waitFor(() => expect(document.activeElement?.id).toBe("to"));
    // Two macrotasks: the scroll restore after paint, then anything later.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const body = aside()?.querySelector<HTMLElement>(".overflow-y-auto");
    expect(scrollIntoView).toHaveBeenCalled();
    expect(body?.scrollTop).toBe(320);
    vi.restoreAllMocks();
  });
});

describe("Template field Escape", () => {
  it("marks a field open only while its menu has rows to draw", async () => {
    const { view, select } = await renderReveal();
    await select("send");
    fireEvent.click(view.getByRole("button", { name: "Focus editor" }));
    const field = await waitFor(() => {
      const element = document.getElementById("to");
      if (!element) {
        throw new Error("the To field did not render");
      }
      return element;
    });

    // Nothing is upstream of the step, so typing `@` finds no row to draw.
    field.focus();
    field.textContent = "@";
    fireEvent.input(field);

    expect(field.getAttribute("data-autocomplete-open")).toBeNull();
    expect(
      document.querySelector('[data-slot="template-autocomplete"]')
    ).toBeNull();
  });
});
