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
import {
  WorkflowIssuesOverlay,
  type WorkflowIssuesOverlayInput,
} from "#src/components/overlays/workflow-issues-overlay";
import { OverlayContainer } from "#src/components/overlays/overlay-container";
import { detailsFloatOpenAtom } from "#src/components/workflow/columns/editor-columns-store";
import { useGoToStep } from "#src/hooks/use-workflow-issues";
import {
  groupWorkflowIssuesForOverlay,
  type WorkflowIssue,
} from "@wfgraph/shared/graph/workflow-issues";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import {
  createStore,
  Provider as JotaiProvider,
  useAtomValue,
  useSetAtom,
} from "jotai";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import {
  OverlayProvider,
  useOverlay,
} from "#src/components/overlays/overlay-provider";
import { DetailsPanel } from "#src/components/workflow/details/details-panel";
import { canvasRevealAtom } from "#src/components/workflow/canvas-reveal/canvas-reveal-state";
import { revealFieldRequestAtom } from "#src/components/workflow/canvas-reveal/reveal-requests";
import {
  type RevealKind,
  revealKind,
} from "#src/components/workflow/canvas-reveal/reveal-kinds";
import { WorkflowContextMenu } from "#src/components/workflow/workflow-context-menu";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import {
  HISTORY_GROUP_PAUSE_MS,
  historyAtom,
} from "#src/lib/workflow-graph-cells";
import {
  addNodeAtom,
  displayNodesAtom,
  executionOverlayGraphAtom,
  loadWorkflowGraphAtom,
  nodesAtom,
  onNodesChangeAtom,
  selectOnlyNodeAtom,
  undoAtom,
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
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
  openNodeRevealFromOriginAtom,
  setWorkspaceRevealLevelAtom,
} from "#src/lib/workflow-workspace-navigation";
import { showWorkspaceRoute } from "#src/lib/workflow-workspace-navigation.test-support";
import {
  answerWorkflowRunRpc,
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcUrl,
} from "#src/lib/rpc-fetch-test-support";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [
    {
      name: "app/reply.received",
      label: "Reply received",
      description: "Raised when the customer replies.",
      payloadFields: [],
    },
  ],
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
    {
      id: "notices/send-letter",
      label: "Send letter",
      description: "Send one letter",
      category: "Notices",
      configFields: [{ key: "body", label: "Body", type: "template-textarea" }],
      outputFields: [],
      links: [
        {
          label: "Preview letter",
          url: "/letters/preview?workflow={workflowId}&node={nodeId}",
        },
      ],
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
  node("wait-event", "Wait for reply", {
    actionType: BUILT_IN_ACTION_IDS.wait,
    waitMode: "event",
    waitFor: [{ event: "app/reply.received" }],
  }),
  node("condition", "Eligible?", { actionType: BUILT_IN_ACTION_IDS.condition }),
  node("letter", "Send letter", { actionType: "notices/send-letter" }),
  // The token was written while "send" was called "Old reminder", so the label
  // stored inside it no longer matches the step's current name.
  node("greet", "Greet", {
    actionType: "mailer/send",
    subject: "Hi {{@send:Old reminder.id}}",
  }),
];

/**
 * A stand-in canvas with a Publish button that opens the issues list a blocked
 * Publish opens, wired to the editor's own Go to step, and the container that
 * draws the list.
 */
function PublishBlockedCanvas() {
  const { open } = useOverlay();
  const goToStep = useGoToStep();
  const issues = useAtomValue(workflowIssuesAtom);
  return (
    <div data-testid="workflow-canvas">
      <div className="react-flow__node" data-id="send" tabIndex={0}>
        Send reminder card
      </div>
      <button
        onClick={() =>
          open<WorkflowIssuesOverlayInput>(WorkflowIssuesOverlay, {
            issues: groupWorkflowIssuesForOverlay(issues),
            trigger: "publish",
            onGoToStep: goToStep,
          })
        }
        type="button"
      >
        Publish
      </button>
      <OverlayContainer />
    </div>
  );
}

const SEND_TO_MISSING: WorkflowIssue = {
  kind: "missing_required_field",
  severity: "blocking",
  nodeId: "send",
  nodeLabel: "Send reminder",
  fieldKey: "to",
  fieldLabel: "To",
  message: "To is required.",
};

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
 * A real React Flow over the Draft, with its selection and delete keys wired to
 * the graph store as the editor canvas wires them, and the canvas context menu
 * opened on the pane.
 */
function FlowCanvas() {
  const nodes = useAtomValue(displayNodesAtom);
  const onNodesChange = useSetAtom(onNodesChangeAtom);
  const [menu, setMenu] = useState<"pane" | "send" | null>(null);
  return (
    <div data-testid="workflow-canvas" style={{ width: 1200, height: 800 }}>
      <ReactFlow
        deleteKeyCode={["Backspace", "Delete"]}
        edges={[]}
        nodes={nodes}
        onNodesChange={onNodesChange}
      />
      <button onClick={() => setMenu("pane")} type="button">
        Open canvas menu
      </button>
      <button onClick={() => setMenu("send")} type="button">
        Open step menu
      </button>
      <WorkflowContextMenu
        canEdit
        canInsert
        menuState={
          menu === null
            ? null
            : menu === "pane"
              ? {
                  type: "pane",
                  position: { x: 10, y: 10 },
                  flowPosition: { x: 0, y: 0 },
                }
              : { type: "node", position: { x: 10, y: 10 }, nodeId: menu }
        }
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

async function renderReveal(
  initialSearch: WorkflowRouteSearch = {},
  options?: {
    selected?: string;
    canvas?: () => ReactNode;
    /** The canvas box width React Flow reports, 1280px when unset. */
    canvasWidth?: number;
  }
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
        canReview: true,
      }),
    component: () => (
      <div className="relative" data-testid="canvas-area">
        <Canvas />
        <DetailsPanel />
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
            <ReactFlowProvider
              {...omitUndefined({
                initialWidth: options?.canvasWidth,
                initialHeight:
                  options?.canvasWidth === undefined ? undefined : 800,
              })}
            >
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
    view.container.querySelector<HTMLElement>('[data-slot="details-panel"]');
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

/**
 * Select `nodeId` and open Reveal as a jump from `originId` does, such as an
 * Event Split's action, so Back has somewhere to return to.
 */
async function openFromOrigin(
  store: ReturnType<typeof createStore>,
  input: { nodeId: string; originId: string }
): Promise<void> {
  await act(async () => {
    store.set(openNodeRevealFromOriginAtom, {
      address: store.get(activeWorkspaceAddressAtom),
      nodeId: input.nodeId,
      origin: { nodeId: input.originId },
    });
  });
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

describe("details panel presentation states", () => {
  it("opens an Action's editor with the workspace, step, path, and status", async () => {
    const { view, level, select, store } = await renderReveal();
    await select("send");

    expect(level()).toBe("browse");
    const region = view.getByRole("complementary", { name: "Step inspector" });
    expect(view.getByRole("heading", { name: "Send reminder" })).toBeTruthy();
    // The header names the step and draws no path.
    expect(region.querySelector("[data-slot=reveal-path]")).toBeNull();
    expect(region.textContent).toContain("Ready");
    // Every setting is its field, and the header changes no level.
    expect(view.getByRole("textbox", { name: "To" })).toBeTruthy();
    expect(view.getByRole("textbox", { name: "Subject" }).textContent).toBe(
      "Hi"
    );
    expect(view.queryByRole("button", { name: "Focus editor" })).toBeNull();
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();

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
    // The header counts the issue at once. The field waits until it has been
    // focused and left empty before it says so beneath itself.
    const to = view.getByRole("textbox", { name: "To" });
    const field = to.closest("div.flex-col");
    expect(field?.querySelector('[data-slot="field-issues"]')).toBeNull();
    fireEvent.focus(to);
    fireEvent.blur(to);
    expect(
      field?.querySelector('[data-slot="field-issues"]')?.textContent
    ).toBe("To is required.");
    expect(view.queryByRole("heading", { name: "Validation" })).toBeNull();
  });

  it("names a reference by its source step's current name in the Settings summary", async () => {
    const { view, level, select } = await renderReveal();
    await select("greet");

    expect(level()).toBe("browse");
    const region = view.getByRole("complementary", { name: "Step inspector" });
    expect(region.textContent).toContain("Hi Send reminder.id");
    expect(region.textContent).not.toContain("Old reminder");
  });

  it("shows a host action's links at Browse", async () => {
    const { view, level, select } = await renderReveal();
    await select("letter");

    expect(level()).toBe("browse");
    expect(view.getByRole("link", { name: "Preview letter" })).toBeTruthy();
  });

  it("opens a Wait's editor with its timing fields", async () => {
    const { view, select } = await renderReveal();
    await select("wait");

    expect(
      view.getByRole("complementary", { name: "Step inspector" })
    ).toBeTruthy();
    expect(view.getByRole("textbox", { name: "Duration" }).textContent).toBe(
      "24h"
    );
    expect(view.queryByRole("button", { name: "Focus editor" })).toBeNull();
  });

  it("shows Event identity and description for an event-mode Wait", async () => {
    const { view, select } = await renderReveal();
    await select("wait-event");

    const region = view.getByRole("complementary", { name: "Step inspector" });
    expect(region.textContent).toContain("Reply received");
    expect(region.textContent).toContain("Raised when the customer replies.");
    expect(region.textContent).toContain("app/reply.received");
  });

  it("opens the Condition inspector on its rule builder", async () => {
    const { view, level, select } = await renderReveal();
    await select("condition");

    expect(level()).toBe("browse");
    expect(
      view.getByRole("complementary", { name: "Condition inspector" })
    ).toBeTruthy();
    expect(view.getByRole("region", { name: "Rule builder" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Focus editor" })).toBeNull();
    expect(view.queryByTestId("properties-panel")).toBeNull();
  });
});

describe("details panel editing", () => {
  it("writes label and description edits to the draft in one autosave", async () => {
    const { view, store, update, select, level } = await renderReveal();
    await select("send");

    fireEvent.change(view.getByLabelText("Label"), {
      target: { value: "Send confirmation" },
    });
    fireEvent.change(view.getByLabelText("Notes"), {
      target: { value: "The day before" },
    });
    expect((view.getByLabelText("Label") as HTMLInputElement).value).toBe(
      "Send confirmation"
    );
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

  it("makes typing in one field one undo step per pause or blur", async () => {
    const { view, store, select } = await renderReveal();
    await select("send");
    const label = view.getByLabelText("Label");
    const type = (value: string) =>
      fireEvent.change(label, { target: { value } });

    label.focus();
    type("Send reminder n");
    type("Send reminder no");
    type("Send reminder now");
    // Leaving the field ends the run of typing.
    fireEvent.blur(label);
    label.focus();
    type("Send reminder now!");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // A pause as long as the group's window starts a new step too.
      vi.setSystemTime(Date.now() + HISTORY_GROUP_PAUSE_MS);
      type("Send reminder now!!");
    } finally {
      vi.useRealTimers();
    }

    const labelOf = () =>
      store.get(nodesAtom).find((item) => item.id === "send")?.data.label;
    act(() => store.set(undoAtom));
    expect(labelOf()).toBe("Send reminder now!");
    act(() => store.set(undoAtom));
    expect(labelOf()).toBe("Send reminder now");
    act(() => store.set(undoAtom));
    expect(labelOf()).toBe("Send reminder");
    expect(store.get(historyAtom)).toEqual([]);
  });

  it("never lays out, moves, dirties, or records history while revealing", async () => {
    const { view, store, select, escape } = await renderReveal();
    const positions = store.get(nodesAtom).map((item) => item.position);
    const graphUpdate = store.get(workflowGraphUpdateAtom);

    await select("send");
    fireEvent.change(view.getByLabelText("Label"), {
      target: { value: "Send reminder" },
    });
    await escape();

    expect(store.get(nodesAtom).map((item) => item.position)).toEqual(
      positions
    );
    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
    expect(store.get(historyAtom)).toEqual([]);
    expect(store.get(workflowGraphUpdateAtom)).toBe(graphUpdate);
  });
});

describe("details panel keyboard and focus", () => {
  it("leaves focus on the canvas object, and Escape in the details hands it back there", async () => {
    const { view, store, select, escape, level } = await renderReveal();
    const card = view.getByText("Send reminder card");
    card.focus();
    await select("send");
    expect(level()).toBe("browse");
    expect(document.activeElement).toBe(card);

    // Details floating over the canvas slides away on that same Escape.
    await act(async () => {
      store.set(detailsFloatOpenAtom, true);
    });
    const label = view.getByLabelText("Label");
    label.focus();
    await escape(label);
    expect(level()).toBe("browse");
    expect(document.activeElement).toBe(card);
    expect(store.get(detailsFloatOpenAtom)).toBe(false);
    expect(store.get(activeSelectionAtom)).toEqual({
      nodeIds: ["send"],
      edgeIds: [],
    });
  });

  it("offers Back only where a jump began, and Back returns there", async () => {
    const { view, store, select, level } = await renderReveal();
    await select("send");
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();

    await openFromOrigin(store, { nodeId: "send", originId: "wait" });
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(level()).toBe("browse");
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["wait"]);
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("runs the kind's own unwind for both Back and Escape", async () => {
    const { view, store, escape, level } = await renderReveal();
    const card = view.getByText("Send reminder card");
    await openFromOrigin(store, { nodeId: "send", originId: "wait" });
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
      const back = view.getByRole("button", { name: "Back" });
      fireEvent.click(back);
      await escape(back);
      expect(level()).toBe("browse");
      expect(unwind).toHaveBeenCalledTimes(2);
      expect(unwind.mock.calls.map(([input]) => input.level)).toEqual([
        "browse",
        "browse",
      ]);
      expect(unwind.mock.calls[1]?.[0].subject).toBe(subject);

      await act(async () => {
        unwind.mock.calls[1]?.[0].unwindLevel();
      });
      expect(level()).toBe("browse");
      expect(document.activeElement).toBe(card);
    } finally {
      kind.unwind = ownUnwind;
    }
  });

  it("opens the one level for a Focus level remembered from before", async () => {
    const { store, select, level } = await renderReveal();
    await select("send");
    await act(async () => {
      store.set(setWorkspaceRevealLevelAtom, {
        address: store.get(activeWorkspaceAddressAtom),
        level: "focus",
      });
    });
    expect(level()).toBe("browse");
  });

  it("leaves Escape to a control that holds a popup open", async () => {
    const { view, select, escape } = await renderReveal();
    await select("send");
    const label = view.getByLabelText("Label");
    label.setAttribute("aria-expanded", "true");

    label.focus();
    await escape(label);
    expect(document.activeElement).toBe(label);

    label.removeAttribute("aria-expanded");
    await escape(label);
    expect(document.activeElement).toBe(view.getByText("Send reminder card"));
  });

  it("leaves Escape to an open Select in the editor", async () => {
    const { view, select, escape, level } = await renderReveal();
    await select("wait");

    fireEvent.click(
      await view.findByRole("combobox", { name: "How should this step wait?" })
    );
    const option = await view.findByRole("option", { name: "Wait for time" });
    await escape(option);
    expect(level()).toBe("browse");
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

describe("details panel navigation state", () => {
  it("restores the open inspector, step, and inspector scroll per scope", async () => {
    const { store, select, aside, level } = await renderReveal();
    await select("send");
    expect(level()).toBe("browse");

    const scroller = () =>
      aside()?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
    const body = scroller();
    if (!body) {
      throw new Error("the step editor did not render");
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

    expect(level()).toBe("browse");
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["send"]);
    await waitFor(() => expect(scroller()?.scrollTop).toBe(140));
  });
});

describe("details panel on a narrow viewport", () => {
  afterEach(() => setViewportWidth(1440));

  it("leaves a selected Draft step to the mobile Reveal sequence", async () => {
    setViewportWidth(500);
    const { view, aside } = await renderReveal({}, { selected: "send" });

    expect(aside()).toBeNull();
    expect(view.queryByTestId("overlay-open")).toBeNull();
  });
});

describe("details panel over a React Flow canvas", () => {
  const flow = { canvas: FlowCanvas };

  it("keeps the step when Backspace or Delete is pressed on a control inside the details", async () => {
    const { view, store, select } = await renderReveal({}, flow);
    await select("send");
    const control = view.container.querySelector<HTMLElement>(
      '[data-slot="reveal-title"]'
    );
    if (!control) {
      throw new Error("the details title did not render");
    }
    control.focus();

    await act(async () => {
      fireEvent.keyDown(control, { key: "Backspace", bubbles: true });
      fireEvent.keyDown(control, { key: "Delete", bubbles: true });
    });

    expect(store.get(nodesAtom).some((item) => item.id === "send")).toBe(true);
  });

  it("leaves Escape on the focused node to the canvas, which deselects it", async () => {
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

    // The details column stays where it is and shows the workflow.
    expect(level()).toBe("browse");
    expect(
      view.getByRole("complementary", { name: "Workflow details" })
    ).toBeTruthy();
    expect(store.get(activeSelectionAtom).nodeIds).toEqual([]);
  });

  it("leaves Escape to an open canvas context menu", async () => {
    const { view, select, escape, level } = await renderReveal({}, flow);
    await select("send");
    fireEvent.click(view.getByRole("button", { name: "Open canvas menu" }));
    expect(view.getByRole("button", { name: /Add step/ })).toBeTruthy();

    await escape(document.body);

    expect(view.queryByRole("button", { name: /Add step/ })).toBeNull();
    expect(level()).toBe("browse");
  });
});

describe("details panel edit focus", () => {
  it("opens the step from the context menu's Edit with focus in its label", async () => {
    const { view, level } = await renderReveal({}, { canvas: FlowCanvas });
    expect(
      view.getByRole("complementary", { name: "Workflow details" })
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Open step menu" }));
    fireEvent.click(
      await view.findByRole("button", { name: "Edit Send reminder" })
    );

    expect(level()).toBe("browse");
    await waitFor(() =>
      expect(document.activeElement).toBe(view.getByLabelText("Label"))
    );
  });

  it("moves focus from the action picker to the first field the chosen action needs", async () => {
    const { view, store, level } = await renderReveal();
    await act(async () => {
      store.set(addNodeAtom, node("new", "", {}));
    });
    expect(level()).toBe("browse");
    expect(document.activeElement).toBe(
      view.getByPlaceholderText("Search actions...")
    );

    fireEvent.click(view.getByTestId("action-option-mailer/send"));

    await waitFor(() => expect(document.activeElement?.id).toBe("to"));
  });
});

describe("what a step does", () => {
  it("names the action in one field with its category, and changes it from the list adding a step uses", async () => {
    const { view, store, select } = await renderReveal();
    await select("send");

    // The field is named by its label and reads the chosen action.
    const field = view.getByRole("button", { name: "Does" });
    expect(field.id).toBe("actionType");
    expect(field.textContent).toBe("Mailer · Send email");
    expect(view.queryByRole("combobox", { name: "Service" })).toBeNull();
    expect(view.queryByRole("combobox", { name: "Action" })).toBeNull();
    expect(view.queryByTestId("action-grid")).toBeNull();

    fireEvent.click(field);
    expect(document.activeElement).toBe(
      view.getByPlaceholderText("Search actions...")
    );
    fireEvent.click(view.getByTestId("action-option-notices/send-letter"));

    expect(view.queryByTestId("action-grid")).toBeNull();
    expect(view.getByRole("button", { name: "Does" }).textContent).toBe(
      "Notices · Send letter"
    );
    expect(
      store.get(nodesAtom).find((item) => item.id === "send")?.data.config
        ?.actionType
    ).toBe("notices/send-letter");
  });

  it("closes the list on Escape and keeps the action", async () => {
    const { view, select } = await renderReveal();
    await select("send");
    fireEvent.click(view.getByRole("button", { name: "Does" }));

    fireEvent.keyDown(view.getByPlaceholderText("Search actions..."), {
      key: "Escape",
    });

    expect(view.queryByTestId("action-grid")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: "Does" })
      )
    );
  });
});

describe("details panel subjects and focus return", () => {
  it("hands focus to the selected node on Escape when it has none to step back to", async () => {
    const { view, store, escape } = await renderReveal();
    const canvas = view.getByTestId("workflow-canvas");
    const second = document.createElement("div");
    second.className = "react-flow__node";
    second.dataset.id = "wait";
    second.tabIndex = 0;
    canvas.append(second);

    await act(async () => {
      store.set(selectOnlyNodeAtom, "wait");
    });
    const title = view.container.querySelector<HTMLElement>(
      '[data-slot="reveal-title"]'
    );
    if (!title) {
      throw new Error("the details title did not render");
    }
    title.focus();
    await escape(title);
    expect(document.activeElement).toBe(second);
  });

  it("gives the run list a header with its title and no Back", async () => {
    const { view, store, level } = await renderReveal({ view: "runs" });
    await act(async () => {
      store.set(executionOverlayGraphAtom, { nodes: [NODES[0]], edges: [] });
    });
    await waitFor(() => expect(level()).toBe("browse"));

    expect(view.getByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("keeps the scroll of a field an issue focused over the stored scroll", async () => {
    const { store, select, aside, level } = await renderReveal();
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

    // What an issue's Edit in the issues list asks of the column.
    await act(async () => {
      store.set(revealFieldRequestAtom, { nodeId: "send", targetId: "to" });
    });
    expect(level()).toBe("browse");
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
  it("scrolls a requested field only as far as its nearest edge, and focuses it without scrolling", async () => {
    const { store, select } = await renderReveal();
    await select("send");
    const scrollIntoView = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
      scrollIntoView
    );
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    await act(async () => {
      store.set(revealFieldRequestAtom, {
        nodeId: "send",
        targetId: "subject",
      });
    });
    await waitFor(() => expect(document.activeElement?.id).toBe("subject"));

    // `block: "nearest"` leaves a field that is already in view where it is,
    // so the panel never re-centres under the pointer.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView).not.toHaveBeenCalledWith(
      expect.objectContaining({ block: "center" })
    );
    const subjectFocus = focus.mock.contexts.findIndex(
      (element) => (element as HTMLElement).id === "subject"
    );
    expect(focus.mock.calls[subjectFocus]?.[0]).toEqual({
      preventScroll: true,
    });
    vi.restoreAllMocks();
  });
});

describe("Template field Escape", () => {
  it("marks a field open only while its menu has rows to draw", async () => {
    const { select } = await renderReveal();
    await select("send");
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

describe("details panel with nothing selected", () => {
  it("shows the workflow's details and issues, and Edit opens the step at its field", async () => {
    const { view, store } = await renderReveal();
    await act(async () => {
      store.set(workflowIssuesAtom, [SEND_TO_MISSING]);
    });

    const panel = view.getByRole("complementary", { name: "Workflow details" });
    expect(
      within(panel).getByRole("heading", { name: "Appointment reminders" })
    ).toBeTruthy();
    expect(panel.textContent).toContain("To is required.");

    fireEvent.click(
      within(panel).getByRole("button", { name: "Edit Send reminder" })
    );

    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["send"]);
    expect(
      view.getByRole("complementary", { name: "Step inspector" })
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe("to"));
  });

  it("opens the step at its field from Edit in the issues list a blocked Publish opens", async () => {
    const { view, store } = await renderReveal(
      {},
      { canvas: PublishBlockedCanvas }
    );
    await act(async () => {
      store.set(workflowIssuesAtom, [SEND_TO_MISSING]);
    });
    const publish = view.getByRole("button", { name: "Publish" });
    publish.focus();
    fireEvent.click(publish);
    const edit = await view.findByRole("button", {
      name: "Edit To in Send reminder",
    });
    expect(view.getByTestId("overlay-open")).toBeTruthy();

    fireEvent.click(edit);

    await waitFor(() => expect(view.queryByTestId("overlay-open")).toBeNull());
    expect(store.get(activeSelectionAtom).nodeIds).toEqual(["send"]);
    expect(
      view.getByRole("complementary", { name: "Step inspector" })
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe("to"));
  });
});
